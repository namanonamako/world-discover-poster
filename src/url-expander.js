const dns = require("node:dns/promises");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
]);

const MAX_HTML_READ_BYTES = 16384;

/**
 * IPv4 文字列を 32bit 符号なし整数へ変換する
 * @param {string} ip
 * @returns {number | null}
 */
function parseIpv4ToUint32(ip) {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * 32bit IPv4 値がプライベート・予約済み範囲か判定する
 * @param {number} val
 * @returns {boolean}
 */
function isPrivateOrReservedIpv4Uint32(val) {
  if (((val & 0xff000000) >>> 0) === 0x00000000) return true; // 0.0.0.0/8
  if (((val & 0xff000000) >>> 0) === 0x0a000000) return true; // 10.0.0.0/8
  if (((val & 0xffc00000) >>> 0) === 0x64400000) return true; // 100.64.0.0/10 (CGNAT)
  if (((val & 0xff000000) >>> 0) === 0x7f000000) return true; // 127.0.0.0/8
  if (((val & 0xffff0000) >>> 0) === 0xa9fe0000) return true; // 169.254.0.0/16 (Link-local / IMDS)
  if (((val & 0xfff00000) >>> 0) === 0xac100000) return true; // 172.16.0.0/12
  if (((val & 0xffffff00) >>> 0) === 0xc0000000) return true; // 192.0.0.0/24
  if (((val & 0xffffff00) >>> 0) === 0xc0000200) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (((val & 0xffffff00) >>> 0) === 0xc0586300) return true; // 192.88.99.0/24 (6to4 relay)
  if (((val & 0xffff0000) >>> 0) === 0xc0a80000) return true; // 192.168.0.0/16
  if (((val & 0xfffe0000) >>> 0) === 0xc6120000) return true; // 198.18.0.0/15 (Benchmarking)
  if (((val & 0xffffff00) >>> 0) === 0xc6336400) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (((val & 0xffffff00) >>> 0) === 0xcb007100) return true; // 203.0.113.0/24 (TEST-NET-3)
  if ((val >>> 28) >= 14) return true; // 224.0.0.0/4 Multicast & 240.0.0.0/4 Reserved
  return false;
}

/**
 * IPv6 文字列を 128bit BigInt へ変換する
 * @param {string} ip
 * @returns {bigint | null}
 */
function parseIpv6ToBigInt(ip) {
  const clean = ip.split("%")[0].toLowerCase();
  if (!net.isIPv6(clean)) return null;

  let normalized = clean;
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const v4Part = normalized.slice(lastColon + 1);
    const v4Val = parseIpv4ToUint32(v4Part);
    if (v4Val === null) return null;
    const hi = ((v4Val >>> 16) & 0xffff).toString(16);
    const lo = (v4Val & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  let groups = [];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = normalized.split(":");
  }

  if (groups.length !== 8) return null;

  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return result;
}

/**
 * @param {bigint} addr
 * @param {bigint} prefix
 * @param {number} prefixLen
 * @returns {boolean}
 */
function inCidrV6(addr, prefix, prefixLen) {
  const shift = BigInt(128 - prefixLen);
  return (addr >> shift) === (prefix >> shift);
}

const RESERVED_V6_PREFIXES = [
  [0x0000_0000_0000_0000_0000_0000_0000_0000n, 96], // ::/96 (Unspecified, ::1, IPv4-compatible)
  [0x0000_0000_0000_0000_ffff_0000_0000_0000n, 96], // ::ffff:0:0:0/96 (IPv4-translated)
  [0x0064_ff9b_0000_0000_0000_0000_0000_0000n, 96], // 64:ff9b::/96 (NAT64)
  [0x0064_ff9b_0001_0000_0000_0000_0000_0000n, 48], // 64:ff9b:1::/48 (NAT64 local)
  [0x0100_0000_0000_0000_0000_0000_0000_0000n, 64], // 100::/64 (Discard-Only)
  [0x2001_0000_0000_0000_0000_0000_0000_0000n, 32], // 2001::/32 (Teredo)
  [0x2001_0002_0000_0000_0000_0000_0000_0000n, 48], // 2001:2::/48 (Benchmarking)
  [0x2001_0010_0000_0000_0000_0000_0000_0000n, 28], // 2001:10::/28 (ORCHID)
  [0x2001_0020_0000_0000_0000_0000_0000_0000n, 28], // 2001:20::/28 (ORCHIDv2)
  [0x2001_0db8_0000_0000_0000_0000_0000_0000n, 32], // 2001:db8::/32 (Documentation)
  [0x2002_0000_0000_0000_0000_0000_0000_0000n, 16], // 2002::/16 (6to4)
  [0xfc00_0000_0000_0000_0000_0000_0000_0000n, 7],  // fc00::/7 (Unique Local)
  [0xfe80_0000_0000_0000_0000_0000_0000_0000n, 10], // fe80::/10 (Link-local)
  [0xfec0_0000_0000_0000_0000_0000_0000_0000n, 10], // fec0::/10 (Site-local deprecated)
  [0xff00_0000_0000_0000_0000_0000_0000_0000n, 8],  // ff00::/8 (Multicast)
];

const V4_MAPPED_V6_PREFIX = 0x0000_0000_0000_0000_0000_ffff_0000_0000n;

/**
 * IPv6 アドレスがプライベート・予約済み範囲に該当するか判定する
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateOrReservedIpv6(ip) {
  const big = parseIpv6ToBigInt(ip);
  if (big === null) return true;

  // ::ffff:0:0/96 (IPv4-mapped IPv6) は埋め込み IPv4 として検査
  if (inCidrV6(big, V4_MAPPED_V6_PREFIX, 96)) {
    const v4Val = Number(big & 0xffff_ffffn);
    return isPrivateOrReservedIpv4Uint32(v4Val);
  }

  return RESERVED_V6_PREFIXES.some(([prefix, len]) => inCidrV6(big, prefix, len));
}

/**
 * IP アドレスが安全（パブリックルーティング可能）か判定する
 * @param {string} ip
 * @returns {boolean}
 */
function isPublicIp(ip) {
  const clean = typeof ip === "string" ? ip.split("%")[0] : "";
  const version = net.isIP(clean);
  if (version === 4) {
    const v4Val = parseIpv4ToUint32(clean);
    return v4Val !== null && !isPrivateOrReservedIpv4Uint32(v4Val);
  }
  if (version === 6) {
    return !isPrivateOrReservedIpv6(clean);
  }
  return false;
}

/**
 * 外部 URL が SSRF の観点で安全か検証し、解決済み IP 一覧を返す
 * @param {string} rawUrl
 * @param {(hostname: string) => Promise<Array<{ address: string, family?: number }>>} [lookupFn]
 * @returns {Promise<{ safe: boolean, addresses: Array<{ address: string, family: number }> }>}
 */
async function validateAndResolveExternalUrl(
  rawUrl,
  lookupFn = (host) => dns.lookup(host, { all: true })
) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, addresses: [] };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, addresses: [] };
  }
  if (parsed.username || parsed.password) {
    return { safe: false, addresses: [] };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, addresses: [] };
  }
  if (
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return { safe: false, addresses: [] };
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion !== 0) {
    if (!isPublicIp(hostname)) {
      return { safe: false, addresses: [] };
    }
    return { safe: true, addresses: [{ address: hostname, family: ipVersion }] };
  }

  try {
    const resolved = await lookupFn(hostname);
    if (!Array.isArray(resolved) || resolved.length === 0) {
      return { safe: false, addresses: [] };
    }
    const normalized = [];
    for (const entry of resolved) {
      if (!entry?.address || !isPublicIp(entry.address)) {
        return { safe: false, addresses: [] };
      }
      normalized.push({
        address: entry.address,
        family: entry.family || net.isIP(entry.address),
      });
    }
    return { safe: true, addresses: normalized };
  } catch {
    return { safe: false, addresses: [] };
  }
}

/**
 * 外部 URL が SSRF の観点で安全か検証する（boolean ヘルパー）
 * @param {string} rawUrl
 * @param {(hostname: string) => Promise<Array<{ address: string, family?: number }>>} [lookupFn]
 * @returns {Promise<boolean>}
 */
async function isSafeExternalUrl(rawUrl, lookupFn) {
  const res = await validateAndResolveExternalUrl(rawUrl, lookupFn);
  return res.safe;
}

/**
 * <meta http-equiv="refresh" content="..."> から安全にリダイレクト URL を抽出する
 * @param {string} html
 * @returns {string | null}
 */
function extractMetaRefreshUrl(html) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    if (!/\bhttp-equiv\s*=\s*(?:"refresh"|'refresh'|refresh(?:\s|>))/i.test(tag)) {
      continue;
    }
    const contentMatch =
      tag.match(/\bcontent\s*=\s*"([^"]*)"/i) ||
      tag.match(/\bcontent\s*=\s*'([^']*)'/i) ||
      tag.match(/\bcontent\s*=\s*([^\s>]+)/i);
    if (!contentMatch) continue;

    const urlMatch = contentMatch[1].match(/\burl\s*=\s*['"]?([^;\s'"]+)/i);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1].replace(/\\/g, "");
    }
  }
  return null;
}

/**
 * 検証済み IP を固定 (DNS pinning) して HTTP/HTTPS GET を行い TOCTOU を防ぐ
 * @param {string} rawUrl
 * @param {Array<{ address: string, family: number }>} pinnedAddresses
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, headers: Record<string, string>, headText: string }>}
 */
function requestWithPinnedDns(rawUrl, pinnedAddresses, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const client = parsed.protocol === "https:" ? https : http;

    const fixedLookup = (_hostname, opts, cb) => {
      if (typeof opts === "function") {
        return opts(null, pinnedAddresses[0].address, pinnedAddresses[0].family);
      }
      if (opts && opts.all) {
        return cb(null, pinnedAddresses);
      }
      return cb(null, pinnedAddresses[0].address, pinnedAddresses[0].family);
    };

    const req = client.request(
      parsed,
      {
        method: "GET",
        lookup: fixedLookup,
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const rawHeaders = res.headers || {};
        const location = Array.isArray(rawHeaders.location)
          ? rawHeaders.location[0]
          : rawHeaders.location || "";
        const contentType = String(rawHeaders["content-type"] || "").toLowerCase();

        if (status >= 200 && status < 300 && contentType.includes("text/html")) {
          const chunks = [];
          let totalBytes = 0;
          let finished = false;

          const finish = () => {
            if (finished) return;
            finished = true;
            const buf = Buffer.concat(chunks);
            resolve({
              status,
              headers: { location, "content-type": contentType },
              headText: buf.toString("utf-8"),
            });
          };

          res.on("data", (chunk) => {
            if (finished) return;
            const remaining = MAX_HTML_READ_BYTES - totalBytes;
            if (remaining <= 0) {
              res.destroy();
              finish();
              return;
            }
            const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            chunks.push(slice);
            totalBytes += slice.length;
            if (totalBytes >= MAX_HTML_READ_BYTES) {
              res.destroy();
              finish();
            }
          });
          res.on("end", finish);
          res.on("close", finish);
          res.on("error", () => finish());
        } else {
          res.destroy();
          resolve({
            status,
            headers: { location, "content-type": contentType },
            headText: "",
          });
        }
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

class UrlExpander {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs=3000]
   * @param {number} [options.maxDepth=5]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {(hostname: string) => Promise<Array<{ address: string, family?: number }>>} [options.lookupFn]
   */
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.maxDepth = options.maxDepth ?? 5;
    this.fetchImpl = options.fetchImpl ?? null;
    this.lookupFn = options.lookupFn;
  }

  /**
   * 短縮 URL を展開し、最終的なリダイレクト先 URL を返す
   * @param {string} url
   * @param {number} [depth=0]
   * @returns {Promise<string>}
   */
  async expand(url, depth = 0) {
    if (depth >= this.maxDepth) return url;

    const { safe, addresses } = await validateAndResolveExternalUrl(url, this.lookupFn);
    if (!safe) {
      return url;
    }

    try {
      let status;
      let location;
      let contentType;
      let headText;

      if (this.fetchImpl) {
        const response = await this.fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });
        status = response.status;
        location = response.headers.get("location") || "";
        contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (response.ok && contentType.includes("text/html")) {
          headText = await this.readHeadText(response, MAX_HTML_READ_BYTES);
        } else {
          await response.body?.cancel?.().catch(() => {});
          headText = "";
        }
      } else {
        const res = await requestWithPinnedDns(url, addresses, this.timeoutMs);
        status = res.status;
        location = res.headers.location;
        contentType = res.headers["content-type"];
        headText = res.headText;
      }

      if (status >= 300 && status < 400 && location) {
        const nextUrl = new URL(location, url).toString();
        return this.expand(nextUrl, depth + 1);
      }

      if (status >= 200 && status < 300 && contentType.includes("text/html") && headText) {
        const metaUrl = extractMetaRefreshUrl(headText);
        if (metaUrl) {
          const nextUrl = new URL(metaUrl, url).toString();
          return this.expand(nextUrl, depth + 1);
        }

        const titleMatch = headText.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
          const titleContent = titleMatch[1].trim();
          if (titleContent.startsWith("http://") || titleContent.startsWith("https://")) {
            return this.expand(titleContent, depth + 1);
          }
        }
      }

      return url;
    } catch {
      return url;
    }
  }

  /**
   * レスポンス先頭のテキストを指定バイト上限まで安全に読み取る
   * @param {Response} response
   * @param {number} maxBytes
   * @returns {Promise<string>}
   */
  async readHeadText(response, maxBytes) {
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      return text.slice(0, maxBytes);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let received = 0;
    let output = "";

    try {
      while (received < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxBytes - received;
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        output += decoder.decode(chunk, { stream: true });
        received += chunk.byteLength;
      }
      output += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }

    return output;
  }
}

module.exports = {
  UrlExpander,
  isSafeExternalUrl,
  validateAndResolveExternalUrl,
  isPublicIp,
  extractMetaRefreshUrl,
};

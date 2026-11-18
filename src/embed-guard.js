const net = require("node:net");
const { sanitizeConsoleText } = require("./utils");

const ALLOWED_EMBED_DOMAINS = ["twitter.com", "twimg.com", "x.com"];
const ALLOWED_WIDGET_SCRIPT_SRC = "https://platform.twitter.com/widgets.js";

/**
 * Puppeteer のページ内リクエストが許可された X/Twitter 埋め込み用ドメインか検証する
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isAllowedEmbedRequestUrl(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  if (rawUrl === "about:blank") return true;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || net.isIP(host) !== 0) {
    return false;
  }

  return ALLOWED_EMBED_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

/**
 * oEmbed API が返却した HTML が安全な Twitter 埋め込みスニペットか検証する
 * @param {string} html
 * @returns {boolean}
 */
function isValidOembedHtml(html) {
  if (typeof html !== "string" || !html.includes("<blockquote")) {
    return false;
  }

  // イベントハンドラ属性・危険タグ・危険スキームを拒否 (<img/onerror=...> も含む)
  if (/(?:^|[\s<\/])on[a-z]+\s*=/i.test(html)) {
    return false;
  }
  if (/<(?:iframe|svg|object|embed|meta|base|link)\b/i.test(html)) {
    return false;
  }
  if (/(?:javascript|vbscript|data):/i.test(html)) {
    return false;
  }

  // インラインスクリプトおよび想定外ドメインのスクリプトをすべて拒否
  const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const tag of scriptTags) {
    const openTagMatch = tag.match(/^<script\b([^>]*)>([\s\S]*?)<\/script>$/i);
    if (!openTagMatch) return false;
    const [, attrs, body] = openTagMatch;
    if (body.trim().length > 0) return false;

    const srcMatches = [...attrs.matchAll(/(?:^|\s)src\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)];
    if (srcMatches.length !== 1) return false;
    const srcVal = srcMatches[0][1] ?? srcMatches[0][2];
    if (srcVal !== ALLOWED_WIDGET_SCRIPT_SRC) {
      return false;
    }
  }

  // 閉じられていない script タグを拒否
  const allOpenScripts = html.match(/<script\b/gi) || [];
  if (allOpenScripts.length !== scriptTags.length) {
    return false;
  }

  return true;
}

module.exports = {
  ALLOWED_EMBED_DOMAINS,
  ALLOWED_WIDGET_SCRIPT_SRC,
  isAllowedEmbedRequestUrl,
  isValidOembedHtml,
  sanitizeConsoleText,
};

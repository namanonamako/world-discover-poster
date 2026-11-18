const { WORLD_ID_EXACT_REGEX, parseRetryAfterSeconds, sanitizeConsoleText } = require("./utils");

const MAX_RETRY_WAIT_SECONDS = 60;
const MAX_WORLD_INFO_BYTES = 2 * 1024 * 1024; // 2MB
const CONTROL_CHAR_REGEX = /[\r\n\x00-\x1f\x7f]/;

/**
 * プロキシ URL が安全（HTTPS、またはローカルテスト用 HTTP）か検証する
 * @param {string} rawProxyUrl
 * @returns {string}
 */
function sanitizeProxyBaseUrl(rawProxyUrl) {
  const trimmed = (typeof rawProxyUrl === "string" ? rawProxyUrl : "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    console.warn("VRChat proxy URL format is invalid; proxy client disabled.");
    return "";
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    console.warn("VRChat proxy URL must not include credentials, query, or hash; proxy client disabled.");
    return "";
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    console.warn("VRChat proxy URL must use https://; proxy client disabled.");
    return "";
  }

  return parsed.toString().replace(/\/+$/, "");
}

/**
 * 認証トークン文字列の安全性を検証する（制御文字禁止）
 * @param {unknown} rawToken
 * @returns {string}
 */
function sanitizeAuthToken(rawToken) {
  if (typeof rawToken !== "string") return "";
  const trimmed = rawToken.trim();
  if (!trimmed || CONTROL_CHAR_REGEX.test(trimmed)) {
    return "";
  }
  return trimmed;
}

/**
 * 環境変数または Secret Manager 由来の VRC_PROXY_TOKENS JSON から認証トークンを解決する
 * 優先順位: 明示指定の VRC_PROXY_AUTH_TOKEN > VRC_PROXY_TOKENS JSON 内の API_AUTH_TOKEN
 * @param {object} [params]
 * @param {string} [params.authToken]
 * @param {string} [params.proxyTokensJson]
 * @returns {string}
 */
function resolveProxyAuthToken(params = {}) {
  const { authToken, proxyTokensJson } = params || {};
  const direct = sanitizeAuthToken(authToken);
  if (direct) {
    return direct;
  }

  if (typeof proxyTokensJson === "string" && proxyTokensJson.trim()) {
    try {
      const parsed = JSON.parse(proxyTokensJson);
      const extracted = sanitizeAuthToken(parsed?.API_AUTH_TOKEN);
      if (extracted) {
        return extracted;
      }
      console.warn("VRC_PROXY_TOKENS does not contain valid API_AUTH_TOKEN; proxy client disabled.");
    } catch {
      console.warn("VRC_PROXY_TOKENS is not valid JSON; proxy client disabled.");
    }
  }

  return "";
}

class VRChatApiClient {
  /**
   * @param {object} [options]
   * @param {string} [options.proxyUrl]
   * @param {string} [options.authToken]
   * @param {typeof fetch} [options.fetchImpl=fetch]
   * @param {(ms: number) => Promise<void>} [options.sleepFn]
   */
  constructor(options = {}) {
    const base = sanitizeProxyBaseUrl(options.proxyUrl);
    this.apiUrl = base ? `${base}/api/1` : "";
    this.authToken = sanitizeAuthToken(options.authToken);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * プロキシ設定が有効か判定する
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(this.apiUrl && this.authToken);
  }

  /**
   * VRChat API（プロキシ経由）からワールド情報を取得する
   * @param {string} worldId
   * @returns {Promise<{ id?: string, unityPackages?: Array<{ platform?: string }> } | null>}
   */
  async getWorldInfo(worldId) {
    if (!this.isConfigured()) {
      return null;
    }
    if (typeof worldId !== "string" || !WORLD_ID_EXACT_REGEX.test(worldId)) {
      console.warn(`Invalid worldId format skipped: ${sanitizeConsoleText(worldId)}`);
      return null;
    }

    const maxRetries = 3;
    let attempt = 0;

    while (true) {
      try {
        const response = await this.fetchImpl(
          `${this.apiUrl}/worlds/${encodeURIComponent(worldId)}`,
          {
            method: "GET",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: {
              "User-Agent": "world-discover-poster/2.0.0",
              Authorization: `Bearer ${this.authToken}`,
            },
          }
        );

        if (response.ok) {
          const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
          if (!Number.isNaN(contentLength) && contentLength > MAX_WORLD_INFO_BYTES) {
            await response.body?.cancel?.().catch(() => {});
            console.warn(`VRChat API proxy response exceeded size limit for ${worldId}.`);
            return null;
          }
          const rawText = await response.text();
          if (Buffer.byteLength(rawText, "utf-8") > MAX_WORLD_INFO_BYTES) {
            console.warn(`VRChat API proxy response body exceeded size limit for ${worldId}.`);
            return null;
          }
          return JSON.parse(rawText);
        }

        attempt++;
        if (response.status === 429 && attempt <= maxRetries) {
          const waitSec = await this.getRetryAfterSeconds(response);
          await response.body?.cancel?.().catch(() => {});
          console.warn(
            `VRChat API proxy returned 429 for ${worldId}. Retrying in ${waitSec}s (attempt ${attempt}/${maxRetries})...`
          );
          await this.sleepFn(waitSec * 1000);
          continue;
        }

        await response.body?.cancel?.().catch(() => {});
        console.warn(
          `VRChat API proxy request failed for ${worldId} with HTTP ${response.status}.`
        );
        return null;
      } catch (error) {
        attempt++;
        if (attempt <= maxRetries) {
          const backoffSec = Math.min(2 ** attempt, MAX_RETRY_WAIT_SECONDS);
          console.warn(
            `VRChat API proxy error for ${worldId} (${sanitizeConsoleText(error?.name || "Error")}). Retrying in ${backoffSec}s...`
          );
          await this.sleepFn(backoffSec * 1000);
          continue;
        }
        console.warn(`Failed to fetch world info for ${worldId} after ${attempt} attempts.`);
        return null;
      }
    }
  }

  /**
   * 429 応答から待機秒数を抽出し上限でキャップする
   * @param {Response} response
   * @returns {Promise<number>}
   */
  async getRetryAfterSeconds(response) {
    try {
      const body = await response.clone().json();
      if (
        typeof body?.retryAfterSeconds === "number" &&
        Number.isFinite(body.retryAfterSeconds) &&
        body.retryAfterSeconds >= 0
      ) {
        return Math.min(Math.ceil(body.retryAfterSeconds), MAX_RETRY_WAIT_SECONDS);
      }
    } catch {
      // JSON パース失敗時はヘッダー参照へフォールバック
    }

    return parseRetryAfterSeconds(response.headers.get("Retry-After"), 5, MAX_RETRY_WAIT_SECONDS);
  }
}

module.exports = {
  VRChatApiClient,
  sanitizeProxyBaseUrl,
  sanitizeAuthToken,
  resolveProxyAuthToken,
};

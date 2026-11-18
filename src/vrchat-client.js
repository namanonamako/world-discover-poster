const { WORLD_ID_EXACT_REGEX, parseRetryAfterSeconds, sanitizeConsoleText } = require("./utils");

const MAX_RETRY_WAIT_SECONDS = 60;

/**
 * プロキシ URL が安全（HTTPS、またはローカルテスト用 HTTP）か検証する
 * @param {string} rawProxyUrl
 * @returns {string}
 */
function sanitizeProxyBaseUrl(rawProxyUrl) {
  const trimmed = (rawProxyUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    console.warn("VRChat proxy URL format is invalid; proxy client disabled.");
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
    this.authToken = (options.authToken || "").trim();
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
    if (!WORLD_ID_EXACT_REGEX.test(worldId)) {
      console.warn(`Invalid worldId format skipped: ${worldId}`);
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
          return await response.json();
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
            `VRChat API proxy error for ${worldId} (${sanitizeConsoleText(error.name || "Error")}). Retrying in ${backoffSec}s...`
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
};

const { parseRetryAfterSeconds, sanitizeConsoleText } = require("./utils");

const DEFAULT_BASE_URL = "https://api.weirapp.io";
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_PAGES = 2;
const MAX_RETRY_WAIT_SECONDS = 60;

class WeirClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.baseUrl="https://api.weirapp.io"]
   * @param {typeof fetch} [options.fetchImpl=fetch]
   * @param {(ms: number) => Promise<void>} [options.sleepFn]
   */
  constructor(options = {}) {
    this.apiKey = (options.apiKey || "").trim();
    if (!this.apiKey) {
      throw new Error("WEIR_API_KEY is required.");
    }
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * X 投稿を検索し、取得した投稿配列を返す
   * @param {object} params
   * @param {string} params.query
   * @param {"latest" | "top"} [params.sort="latest"]
   * @param {number} [params.limit=50]
   * @param {string | null} [params.sinceId=null]
   * @param {string | null} [params.since=null]
   * @param {number} [params.maxPages=2]
   * @returns {Promise<Array<object>>}
   */
  async searchPosts({
    query,
    sort = "latest",
    limit = DEFAULT_LIMIT,
    sinceId = null,
    since = null,
    maxPages = DEFAULT_MAX_PAGES,
  }) {
    const effectiveMaxPages =
      Number.isInteger(maxPages) && maxPages >= 1 ? maxPages : DEFAULT_MAX_PAGES;
    const posts = [];
    let cursor = null;

    for (let page = 1; page <= effectiveMaxPages; page++) {
      const payload = {
        query,
        sort,
        limit,
      };
      if (sinceId) {
        payload.sinceId = sinceId;
      } else if (since) {
        payload.since = since;
      }
      if (cursor) {
        payload.cursor = cursor;
      }

      const result = await this.requestSearch(payload);
      const pageItems = Array.isArray(result?.data) ? result.data : [];
      posts.push(...pageItems);

      const nextCursor = result?.meta?.nextCursor;
      if (!nextCursor || pageItems.length === 0 || nextCursor === cursor) {
        break;
      }
      if (page === effectiveMaxPages) {
        console.warn(
          `Weir API pagination reached maxPages (${effectiveMaxPages}); remaining results may be truncated.`
        );
        break;
      }
      cursor = nextCursor;
    }

    return posts;
  }

  /**
   * 単一ページの検索リクエストをリトライ制御付きで実行する
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async requestSearch(payload) {
    const maxRetries = 3;
    let attempt = 0;

    while (true) {
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/v1/x/search`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          const data = await response.json();
          const charged = response.headers.get("x-credits-charged");
          const remaining = response.headers.get("x-credits-remaining");
          if (charged !== null || remaining !== null) {
            console.log(
              `Weir API credits: charged=${charged ?? "unknown"}, remaining=${remaining ?? "unknown"}`
            );
          }
          return data;
        }
      } catch (error) {
        attempt++;
        if (attempt <= maxRetries) {
          const backoffSec = Math.min(2 ** attempt, MAX_RETRY_WAIT_SECONDS);
          console.warn(
            `Weir API network/parse error (${error.name || "Error"}). Retrying in ${backoffSec}s (attempt ${attempt}/${maxRetries})...`
          );
          await this.sleepFn(backoffSec * 1000);
          continue;
        }
        throw new Error(`Weir API request failed after ${attempt} attempts: ${error.message}`);
      }

      attempt++;
      if ((response.status === 429 || response.status >= 500) && attempt <= maxRetries) {
        const waitSec = parseRetryAfterSeconds(
          response.headers.get("Retry-After"),
          2 ** attempt,
          MAX_RETRY_WAIT_SECONDS
        );
        await response.body?.cancel?.().catch(() => {});
        console.warn(
          `Weir API returned HTTP ${response.status}. Retrying in ${waitSec}s (attempt ${attempt}/${maxRetries})...`
        );
        await this.sleepFn(waitSec * 1000);
        continue;
      }

      let errorCode = "";
      try {
        const errBody = await response.json();
        errorCode = errBody?.error?.code || errBody?.code || errBody?.message || "";
      } catch {
        await response.body?.cancel?.().catch(() => {});
      }
      const detail = errorCode ? ` (${sanitizeConsoleText(String(errorCode).slice(0, 120))})` : "";
      throw new Error(`Weir API returned HTTP ${response.status}${detail}`);
    }
  }
}

module.exports = {
  WeirClient,
  DEFAULT_LIMIT,
  DEFAULT_MAX_PAGES,
};

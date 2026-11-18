const WORLD_ID_REGEX = /wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WORLD_ID_EXACT_REGEX = /^wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWEET_URL_REGEX = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?=$|[/?#])/;

/**
 * ツイート URL の形式を検証し、正規化した URL を返す
 * @param {string} rawUrl
 * @param {"x.com" | "twitter.com"} [preferredHost="x.com"]
 * @returns {string | null}
 */
function normalizeTweetUrl(rawUrl, preferredHost = "x.com") {
  if (typeof rawUrl !== "string") return null;
  const match = rawUrl.trim().match(TWEET_URL_REGEX);
  if (!match) return null;
  const [, username, statusId] = match;
  return `https://${preferredHost}/${username}/status/${statusId}`;
}

/**
 * カンマ区切りのブラックリスト文字列を配列へパースする
 * @param {string | undefined} rawValue
 * @returns {string[]}
 */
function parseBlackList(rawValue) {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return [];
  }
  return rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Retry-After ヘッダー値を待機秒数へ変換し上限でキャップする
 * @param {string | null} retryAfterHeader
 * @param {number} fallbackSeconds
 * @param {number} [maxSeconds=60]
 * @returns {number}
 */
function parseRetryAfterSeconds(retryAfterHeader, fallbackSeconds, maxSeconds = 60) {
  if (typeof retryAfterHeader === "string") {
    const trimmed = retryAfterHeader.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      return Math.min(parsed, maxSeconds);
    }
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
      const diffSec = Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
      return Math.min(diffSec, maxSeconds);
    }
  }
  return Math.min(Math.max(0, fallbackSeconds), maxSeconds);
}

/**
 * GitHub Actions ログへのコマンド注入 (::error:: 等) や制御文字を無害化する
 * @param {string} text
 * @returns {string}
 */
function sanitizeConsoleText(text) {
  return String(text || "")
    .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
    .replace(/^(\s*)::/, "$1: :");
}

module.exports = {
  WORLD_ID_REGEX,
  WORLD_ID_EXACT_REGEX,
  TWEET_URL_REGEX,
  normalizeTweetUrl,
  parseBlackList,
  parseRetryAfterSeconds,
  sanitizeConsoleText,
};

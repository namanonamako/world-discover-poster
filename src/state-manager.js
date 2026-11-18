const fs = require("node:fs");
const path = require("node:path");
const { WORLD_ID_EXACT_REGEX, sanitizeConsoleText } = require("./utils");

const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日間
const SNOWFLAKE_ID_REGEX = /^\d+$/;

/**
 * 期限切れ・不正なキャッシュエントリを除外する
 * @param {Record<string, { hasQuest: boolean, expireAt: number }>} cache
 * @param {number} [now=Date.now()]
 * @returns {Record<string, { hasQuest: boolean, expireAt: number }>}
 */
function pruneWorldCache(cache, now = Date.now()) {
  if (!cache || typeof cache !== "object") {
    return {};
  }

  const pruned = {};
  for (const [worldId, entry] of Object.entries(cache)) {
    if (
      WORLD_ID_EXACT_REGEX.test(worldId) &&
      entry &&
      typeof entry.hasQuest === "boolean" &&
      typeof entry.expireAt === "number" &&
      Number.isFinite(entry.expireAt) &&
      entry.expireAt > now
    ) {
      pruned[worldId.toLowerCase()] = {
        hasQuest: entry.hasQuest,
        expireAt: entry.expireAt,
      };
    }
  }
  return pruned;
}

/**
 * 状態ファイルを安全に読み込む
 * @param {string} filePath
 * @param {number} [now=Date.now()]
 * @returns {{ version: number, lastTweetId: string | null, lastUpdatedAt: string | null, worldCache: Record<string, { hasQuest: boolean, expireAt: number }> }}
 */
function loadState(filePath, now = Date.now()) {
  const emptyState = {
    version: 1,
    lastTweetId: null,
    lastUpdatedAt: null,
    worldCache: {},
  };

  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      return emptyState;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    const lastTweetId =
      typeof parsed?.lastTweetId === "string" && SNOWFLAKE_ID_REGEX.test(parsed.lastTweetId)
        ? parsed.lastTweetId
        : null;

    return {
      version: 1,
      lastTweetId,
      lastUpdatedAt: typeof parsed?.lastUpdatedAt === "string" ? parsed.lastUpdatedAt : null,
      worldCache: pruneWorldCache(parsed?.worldCache, now),
    };
  } catch (error) {
    console.warn(`Failed to load poster state from ${filePath}: ${sanitizeConsoleText(error?.message ?? error)}`);
    return emptyState;
  }
}

/**
 * 状態ファイルを保存する
 * @param {string} filePath
 * @param {object} state
 * @param {number} [now=Date.now()]
 */
function saveState(filePath, state, now = Date.now()) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const sanitized = {
    version: 1,
    lastTweetId:
      typeof state?.lastTweetId === "string" && SNOWFLAKE_ID_REGEX.test(state.lastTweetId)
        ? state.lastTweetId
        : null,
    lastUpdatedAt: new Date(now).toISOString(),
    worldCache: pruneWorldCache(state?.worldCache, now),
  };

  fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2));
}

/**
 * 投稿配列の中から最大の Snowflake ID を返す
 * @param {string | null} currentMaxId
 * @param {Array<{ id?: string }>} posts
 * @returns {string | null}
 */
function getMaxTweetId(currentMaxId, posts) {
  let maxBigInt =
    typeof currentMaxId === "string" && SNOWFLAKE_ID_REGEX.test(currentMaxId)
      ? BigInt(currentMaxId)
      : null;

  if (!Array.isArray(posts)) {
    return maxBigInt !== null ? maxBigInt.toString() : null;
  }

  for (const post of posts) {
    if (typeof post?.id === "string" && SNOWFLAKE_ID_REGEX.test(post.id)) {
      const candidate = BigInt(post.id);
      if (maxBigInt === null || candidate > maxBigInt) {
        maxBigInt = candidate;
      }
    }
  }

  return maxBigInt !== null ? maxBigInt.toString() : null;
}

/**
 * 状態に手動オーバーライド（例: lastTweetId リセット）を適用する
 * @param {{ version: number, lastTweetId: string | null, lastUpdatedAt: string | null, worldCache: Record<string, { hasQuest: boolean, expireAt: number }> }} state
 * @param {{ resetLastTweetId?: boolean }} [options]
 */
function applyStateOverrides(state, { resetLastTweetId = false } = {}) {
  if (!resetLastTweetId) {
    return state;
  }
  return {
    ...state,
    lastTweetId: null,
  };
}

/**
 * キャプチャ結果に基づき lastTweetId を更新せず前回値を維持すべきか判定する
 * 対象ツイートが存在し、1件も新規キャプチャできず、かつエラーが発生した場合のみ true
 * @param {{ targetCount: number, capturedCount: number, errorCount: number }} stats
 * @returns {boolean}
 */
function shouldPreserveLastTweetId({ targetCount = 0, capturedCount = 0, errorCount = 0 } = {}) {
  return targetCount > 0 && capturedCount === 0 && errorCount > 0;
}

/**
 * キャプチャ全面失敗時に前回の lastTweetId を維持しつつ worldCache のみ引き継いだ状態を生成する
 * @param {object | null} prevState
 * @param {object | null} nextState
 * @param {number} [now=Date.now()]
 */
function buildStatePreservingLastTweetId(prevState, nextState, now = Date.now()) {
  const mergedCache = {
    ...(prevState?.worldCache && typeof prevState.worldCache === "object" ? prevState.worldCache : {}),
    ...(nextState?.worldCache && typeof nextState.worldCache === "object" ? nextState.worldCache : {}),
  };
  return {
    version: 1,
    lastTweetId:
      typeof prevState?.lastTweetId === "string" && SNOWFLAKE_ID_REGEX.test(prevState.lastTweetId)
        ? prevState.lastTweetId
        : null,
    lastUpdatedAt: new Date(now).toISOString(),
    worldCache: pruneWorldCache(mergedCache, now),
  };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  pruneWorldCache,
  loadState,
  saveState,
  getMaxTweetId,
  applyStateOverrides,
  shouldPreserveLastTweetId,
  buildStatePreservingLastTweetId,
};

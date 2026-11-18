const fs = require("node:fs");
const path = require("node:path");
const { WORLD_ID_EXACT_REGEX } = require("./utils");

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
    console.warn(`Failed to load poster state from ${filePath}: ${error.message}`);
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

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  pruneWorldCache,
  loadState,
  saveState,
  getMaxTweetId,
};

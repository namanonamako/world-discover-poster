const { DEFAULT_CACHE_TTL_MS, getMaxTweetId, pruneWorldCache } = require("./state-manager");
const { normalizeTweetUrl } = require("./utils");
const { DEFAULT_LIMIT, DEFAULT_MAX_PAGES } = require("./weir-client");

const DEFAULT_SEARCH_QUERY =
  "(#VRChat_world紹介 OR #VRChat_quest_world) -filter:retweets -filter:replies";
const MAX_HASHTAGS = 5;
const FALLBACK_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 初回実行時は直近24時間

/**
 * 投稿からハッシュタグ一覧（小文字正規化済み Set とカウント）を抽出する
 * @param {object} post
 * @returns {{ tags: Set<string>, count: number }}
 */
function extractHashtags(post) {
  const entityTags = Array.isArray(post?.entities?.hashtags)
    ? post.entities.hashtags
        .filter((t) => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim().replace(/^#/, ""))
    : [];

  const text = typeof post?.text === "string" ? post.text : "";
  // URL フラグメント (#section) を誤カウントしないよう URL 文字列を除去してから抽出
  const textWithoutUrls = text.replace(/https?:\/\/[^\s"'<>]+/g, "");
  const textTagMatches = textWithoutUrls.match(/#[^\s#]+/g) || [];
  const textTags = textTagMatches
    .map((t) => t.slice(1).replace(/[.,!?;:)\]}」』、。]+$/, ""))
    .filter((t) => t.length > 0);

  const uniqueLower = new Set([...entityTags, ...textTags].map((t) => t.toLowerCase()));
  const count = Math.max(entityTags.length, textTags.length, uniqueLower.size);

  return { tags: uniqueLower, count };
}

/**
 * スパム判定（ハッシュタグが5個以上）
 * @param {{ tags: Set<string>, count: number }} hashtagInfo
 * @returns {boolean}
 */
function isSpamPost(hashtagInfo) {
  return hashtagInfo.count >= MAX_HASHTAGS;
}

/**
 * ブラックリスト対象か判定する（大文字/小文字を区別しない）
 * @param {string} tweetUrl
 * @param {string | undefined} username
 * @param {string[]} blackList
 * @returns {boolean}
 */
function isBlacklisted(tweetUrl, username, blackList) {
  if (!Array.isArray(blackList) || blackList.length === 0) {
    return false;
  }
  const lowerUrl = tweetUrl.toLowerCase();
  const lowerUser = typeof username === "string" ? username.toLowerCase() : "";
  return blackList.some((entry) => {
    if (typeof entry !== "string" || !entry) return false;
    const lowerEntry = entry.toLowerCase();
    return lowerUrl.includes(lowerEntry) || (lowerUser && lowerUser === lowerEntry);
  });
}

/**
 * 投稿配列を Snowflake ID 降順（最新順）にソートする
 * @param {Array<object>} posts
 * @returns {Array<object>}
 */
function sortPostsLatestFirst(posts) {
  return [...posts].sort((a, b) => {
    const idA = /^\d+$/.test(String(a?.id || "")) ? BigInt(a.id) : 0n;
    const idB = /^\d+$/.test(String(b?.id || "")) ? BigInt(b.id) : 0n;
    if (idB > idA) return 1;
    if (idB < idA) return -1;
    return 0;
  });
}

/**
 * Weir API・WorldIdExtractor・VRChatApiClient を組み合わせてワールド紹介情報を収集する
 * @param {object} deps
 * @param {import("./weir-client").WeirClient} deps.weirClient
 * @param {import("./world-id-extractor").WorldIdExtractor} deps.extractor
 * @param {import("./vrchat-client").VRChatApiClient} deps.vrchatClient
 * @param {object} [options]
 * @param {object} [options.state]
 * @param {string[]} [options.blackList=[]]
 * @param {string} [options.query=DEFAULT_SEARCH_QUERY]
 * @param {number} [options.limit=50]
 * @param {number} [options.maxPages=2]
 * @param {number} [options.now=Date.now()]
 * @returns {Promise<{ posterData: { pcWorlds: Array<{ url: string, worldId: string }>, questWorlds: Array<{ url: string, worldId: string }> }, nextState: object, stats: object }>}
 */
async function collectWorldIntroductions(
  { weirClient, extractor, vrchatClient },
  {
    state = { version: 1, lastTweetId: null, lastUpdatedAt: null, worldCache: {} },
    blackList = [],
    query = DEFAULT_SEARCH_QUERY,
    limit = DEFAULT_LIMIT,
    maxPages = DEFAULT_MAX_PAGES,
    now = Date.now(),
  } = {}
) {
  const sinceId = state?.lastTweetId || null;
  const fallbackSince = sinceId ? null : new Date(now - FALLBACK_LOOKBACK_MS).toISOString();

  const rawPosts = await weirClient.searchPosts({
    query,
    sort: "latest",
    limit,
    sinceId,
    since: fallbackSince,
    maxPages,
  });

  const sortedPosts = sortPostsLatestFirst(rawPosts);
  const nextWorldCache = pruneWorldCache(state?.worldCache, now);

  const pcWorlds = [];
  const questWorlds = [];
  const seenPcUrls = new Set();
  const seenQuestUrls = new Set();

  let skippedSpam = 0;
  let skippedBlacklist = 0;
  let skippedInvalid = 0;
  let questAutoDetected = 0;

  for (const post of sortedPosts) {
    const tweetUrl =
      normalizeTweetUrl(post?.url, "x.com") ||
      (post?.author?.username && post?.id
        ? normalizeTweetUrl(`https://x.com/${post.author.username}/status/${post.id}`, "x.com")
        : null);

    if (!tweetUrl) {
      skippedInvalid++;
      continue;
    }

    if (isBlacklisted(tweetUrl, post?.author?.username, blackList)) {
      skippedBlacklist++;
      continue;
    }

    const hashtagInfo = extractHashtags(post);
    if (isSpamPost(hashtagInfo)) {
      skippedSpam++;
      continue;
    }

    const isPc = hashtagInfo.tags.has("vrchat_world紹介");
    const isQuest = hashtagInfo.tags.has("vrchat_quest_world");
    if (!isPc && !isQuest) {
      skippedInvalid++;
      continue;
    }

    // すでに両対象プラットフォームで処理済みの重複 URL は外部展開等をスキップ
    if ((!isPc || seenPcUrls.has(tweetUrl)) && (!isQuest || seenQuestUrls.has(tweetUrl))) {
      continue;
    }

    const expandedUrls = Array.isArray(post?.entities?.urls) ? post.entities.urls : [];
    const worldId = await extractor.extract({
      text: typeof post?.text === "string" ? post.text : "",
      expandedUrls,
    });

    if (isPc && !seenPcUrls.has(tweetUrl)) {
      pcWorlds.push({ url: tweetUrl, worldId });
      seenPcUrls.add(tweetUrl);
    }

    let resolvedQuest = isQuest;

    if (isPc && worldId && !isQuest) {
      let hasQuest = false;
      const cached = nextWorldCache[worldId];

      if (cached && cached.expireAt > now) {
        hasQuest = cached.hasQuest;
      } else if (vrchatClient && vrchatClient.isConfigured()) {
        const worldInfo = await vrchatClient.getWorldInfo(worldId);
        if (worldInfo) {
          hasQuest = Boolean(
            worldInfo.unityPackages?.some(
              (pkg) => typeof pkg?.platform === "string" && pkg.platform.toLowerCase() === "android"
            )
          );
          nextWorldCache[worldId] = {
            hasQuest,
            expireAt: now + DEFAULT_CACHE_TTL_MS,
          };
        }
      }

      if (hasQuest) {
        resolvedQuest = true;
        questAutoDetected++;
      }
    }

    if (resolvedQuest && !seenQuestUrls.has(tweetUrl)) {
      questWorlds.push({ url: tweetUrl, worldId });
      seenQuestUrls.add(tweetUrl);
    }
  }

  const nextLastTweetId = getMaxTweetId(sinceId, sortedPosts);

  return {
    posterData: {
      pcWorlds,
      questWorlds,
    },
    nextState: {
      version: 1,
      lastTweetId: nextLastTweetId,
      lastUpdatedAt: new Date(now).toISOString(),
      worldCache: nextWorldCache,
    },
    stats: {
      fetchedPosts: sortedPosts.length,
      pcCount: pcWorlds.length,
      questCount: questWorlds.length,
      questAutoDetected,
      skippedSpam,
      skippedBlacklist,
      skippedInvalid,
    },
  };
}

module.exports = {
  DEFAULT_SEARCH_QUERY,
  MAX_HASHTAGS,
  extractHashtags,
  isSpamPost,
  isBlacklisted,
  sortPostsLatestFirst,
  collectWorldIntroductions,
};

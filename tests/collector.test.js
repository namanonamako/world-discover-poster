const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { collectWorldIntroductions } = require("../src/collector");
const { WorldIdExtractor } = require("../src/world-id-extractor");

describe("collectWorldIntroductions", () => {
  const extractor = new WorldIdExtractor({ expand: async (u) => u });

  it("filters spam (>= 5 hashtags), ignores URL fragments, applies case-insensitive blacklist, and auto-detects Quest", async () => {
    const now = 1_700_000_000_000;
    const worldIdQuest = "wrld_11111111-1111-1111-1111-111111111111";
    const worldIdPcOnly = "wrld_22222222-2222-2222-2222-222222222222";
    const worldIdCached = "wrld_33333333-3333-3333-3333-333333333333";

    const vrcCalls = [];
    let receivedSearchParams = null;
    const mockWeir = {
      searchPosts: async (params) => {
        receivedSearchParams = params;
        return [
        // 1. スパム (ハッシュタグ5個) - ただし lastTweetId は更新されるべき
        {
          id: "500",
          url: "https://x.com/spammer/status/500",
          text: "#VRChat_world紹介 #t1 #t2 #t3 #t4",
          entities: { hashtags: ["VRChat_world紹介", "t1", "t2", "t3", "t4"], urls: [] },
        },
        // 2. 大文字小文字違いのブラックリスト対象
        {
          id: "400",
          url: "https://x.com/BadUser/status/400",
          text: "#VRChat_world紹介",
          entities: { hashtags: ["VRChat_world紹介"], urls: [] },
        },
        // 3. PC ツイート (URL フラグメント含み + 句読点隣接タグでもスパム誤判定しないこと) -> VRChat API で android 検出
        {
          id: "300",
          url: "https://x.com/alice/status/300?s=20",
          text: "New world! https://example.com/docs#section1 #VRChat_world紹介、 #VRChat #VRC #紹介",
          entities: {
            hashtags: ["VRChat_world紹介", "VRChat", "VRC", "紹介"],
            urls: [`https://vrchat.com/home/world/${worldIdQuest}`],
          },
        },
        // 4. PC ツイート (キャッシュヒットで API コールなし、Quest 非対応)
        {
          id: "200",
          url: "https://x.com/bob/status/200",
          text: "PC only world #VRChat_world紹介",
          entities: {
            hashtags: ["VRChat_world紹介"],
            urls: [`https://vrchat.com/home/world/${worldIdCached}`],
          },
        },
        // 5. 両方のハッシュタグが付いたツイート + twitter.com / x.com 重複排除
        {
          id: "100",
          url: "https://twitter.com/carol/status/100",
          text: "Cross platform! #VRChat_world紹介 #VRChat_quest_world",
          entities: {
            hashtags: ["VRChat_world紹介", "VRChat_quest_world"],
            urls: [`https://vrchat.com/home/world/${worldIdPcOnly}`],
          },
        },
        {
          id: "100",
          url: "https://x.com/carol/status/100",
          text: "Cross platform! #VRChat_world紹介 #VRChat_quest_world",
          entities: {
            hashtags: ["VRChat_world紹介", "VRChat_quest_world"],
            urls: [`https://vrchat.com/home/world/${worldIdPcOnly}`],
          },
        },
      ];
      },
    };

    const mockVrchat = {
      isConfigured: () => true,
      getWorldInfo: async (worldId) => {
        vrcCalls.push(worldId);
        return {
          id: worldId,
          unityPackages: [{ platform: "standalonewindows" }, { platform: "android" }],
        };
      },
    };

    const result = await collectWorldIntroductions(
      { weirClient: mockWeir, extractor, vrchatClient: mockVrchat },
      {
        state: {
          version: 1,
          lastTweetId: "50",
          worldCache: {
            [worldIdCached]: { hasQuest: false, expireAt: now + 60_000 },
          },
        },
        blackList: ["baduser"],
        now,
      }
    );

    assert.deepEqual(result.posterData.pcWorlds, [
      { url: "https://x.com/alice/status/300", worldId: worldIdQuest },
      { url: "https://x.com/bob/status/200", worldId: worldIdCached },
      { url: "https://x.com/carol/status/100", worldId: worldIdPcOnly },
    ]);

    assert.deepEqual(result.posterData.questWorlds, [
      { url: "https://x.com/alice/status/300", worldId: worldIdQuest },
      { url: "https://x.com/carol/status/100", worldId: worldIdPcOnly },
    ]);

    assert.deepEqual(vrcCalls, [worldIdQuest]);
    assert.equal(receivedSearchParams.maxPages, 2);
    assert.equal(receivedSearchParams.limit, 50);
    assert.equal(result.nextState.lastTweetId, "500");
    assert.equal(result.nextState.worldCache[worldIdQuest].hasQuest, true);
    assert.equal(result.stats.skippedSpam, 1);
    assert.equal(result.stats.skippedBlacklist, 1);
    assert.equal(result.stats.questAutoDetected, 1);
  });

  it("uses fallbackSince when lastTweetId is null and does not cache failed VRChat API calls", async () => {
    const now = 1_700_000_000_000;
    let receivedSince = null;
    const mockWeir = {
      searchPosts: async ({ since }) => {
        receivedSince = since;
        return [
          {
            id: "123",
            url: "https://x.com/i/web/status/123",
            author: { username: "dave" },
            text: "#VRChat_world紹介",
            entities: {
              hashtags: ["VRChat_world紹介"],
              urls: ["https://vrchat.com/home/world/wrld_44444444-4444-4444-4444-444444444444"],
            },
          },
        ];
      },
    };
    const mockVrchat = {
      isConfigured: () => true,
      getWorldInfo: async () => null,
    };

    const result = await collectWorldIntroductions(
      { weirClient: mockWeir, extractor, vrchatClient: mockVrchat },
      { state: { version: 1, lastTweetId: null, worldCache: {} }, now }
    );

    assert.equal(receivedSince, new Date(now - 24 * 60 * 60 * 1000).toISOString());
    assert.deepEqual(result.posterData.pcWorlds, [
      { url: "https://x.com/dave/status/123", worldId: "wrld_44444444-4444-4444-4444-444444444444" },
    ]);
    assert.deepEqual(result.nextState.worldCache, {});
  });
});

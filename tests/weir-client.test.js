const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { WeirClient } = require("../src/weir-client");
const { parseRetryAfterSeconds } = require("../src/utils");

describe("WeirClient & parseRetryAfterSeconds", () => {
  it("throws if apiKey is missing", () => {
    assert.throws(() => new WeirClient({ apiKey: "" }), /WEIR_API_KEY is required/);
  });

  it("parses Retry-After integer seconds and HTTP-dates without misinterpreting ISO dates", () => {
    assert.equal(parseRetryAfterSeconds("12", 5, 60), 12);
    assert.equal(parseRetryAfterSeconds("120", 5, 60), 60);
    // ISO日付の先頭年(2026)を秒数と誤認しないこと
    const pastIso = "2020-01-01T00:00:00Z";
    assert.equal(parseRetryAfterSeconds(pastIso, 5, 60), 0);
  });

  it("paginates using meta.nextCursor and passes sinceId", async () => {
    const capturedBodies = [];
    let callCount = 0;
    const client = new WeirClient({
      apiKey: "weir_live_secret_token",
      fetchImpl: async (_url, init) => {
        callCount++;
        capturedBodies.push(JSON.parse(init.body));
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              data: [{ id: "200" }],
              meta: { nextCursor: "cursor_1" },
            }),
            { status: 200, headers: { "x-credits-charged": "2", "x-credits-remaining": "4998" } }
          );
        }
        return new Response(
          JSON.stringify({
            data: [{ id: "199" }],
            meta: {},
          }),
          { status: 200 }
        );
      },
    });

    const posts = await client.searchPosts({
      query: "#VRChat_world紹介",
      sinceId: "150",
      since: "2026-11-17T00:00:00.000Z",
      maxPages: 3,
    });

    assert.equal(posts.length, 2);
    assert.equal(capturedBodies[0].sinceId, "150");
    assert.equal(capturedBodies[0].since, undefined);
    assert.equal(capturedBodies[1].cursor, "cursor_1");
  });

  it("stops pagination when cursor repeats or maxPages is reached", async () => {
    let calls = 0;
    const client = new WeirClient({
      apiKey: "weir_live_secret",
      fetchImpl: async () => {
        calls++;
        return new Response(
          JSON.stringify({ data: [{ id: String(calls) }], meta: { nextCursor: "same" } }),
          { status: 200 }
        );
      },
    });

    const posts = await client.searchPosts({ query: "test", maxPages: 5 });
    assert.equal(calls, 2);
    assert.equal(posts.length, 2);
  });

  it("retries on 429 and network/parse errors", async () => {
    let attempts = 0;
    const slept = [];
    const client = new WeirClient({
      apiKey: "weir_live_secret",
      sleepFn: async (ms) => slept.push(ms),
      fetchImpl: async () => {
        attempts++;
        if (attempts === 1) {
          return new Response("rate limited", { status: 429, headers: { "Retry-After": "3" } });
        }
        if (attempts === 2) {
          return new Response("not json", { status: 200 });
        }
        return new Response(JSON.stringify({ data: [{ id: "10" }], meta: {} }), { status: 200 });
      },
    });

    const posts = await client.searchPosts({ query: "test" });
    assert.equal(posts.length, 1);
    assert.equal(attempts, 3);
    assert.deepEqual(slept, [3000, 4000]);
  });

  it("does not leak apiKey in thrown errors", async () => {
    const secret = "weir_live_super_secret_12345";
    const client = new WeirClient({
      apiKey: secret,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 }),
    });

    await assert.rejects(
      () => client.searchPosts({ query: "test" }),
      (err) => {
        assert.match(err.message, /HTTP 401/);
        assert.equal(err.message.includes(secret), false);
        return true;
      }
    );
  });
});

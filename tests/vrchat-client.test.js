const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { VRChatApiClient, sanitizeProxyBaseUrl } = require("../src/vrchat-client");

describe("VRChatApiClient", () => {
  it("skips requests when proxy is not configured", async () => {
    let called = false;
    const client = new VRChatApiClient({
      proxyUrl: "",
      authToken: "",
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    });
    assert.equal(client.isConfigured(), false);
    const info = await client.getWorldInfo("wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6");
    assert.equal(info, null);
    assert.equal(called, false);
  });

  it("enforces https:// for non-local proxy URLs", () => {
    assert.equal(sanitizeProxyBaseUrl("http://remote-proxy.example.com"), "");
    assert.equal(sanitizeProxyBaseUrl("http://localhost:8080/"), "http://localhost:8080");
    assert.equal(sanitizeProxyBaseUrl("http://[::1]:8080/"), "http://[::1]:8080");
    assert.equal(sanitizeProxyBaseUrl("https://proxy.example.com/v2/"), "https://proxy.example.com/v2");
  });

  it("rejects invalid worldId format to prevent path traversal", async () => {
    let called = false;
    const client = new VRChatApiClient({
      proxyUrl: "https://proxy.example.com",
      authToken: "token",
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    });
    const info = await client.getWorldInfo("../admin");
    assert.equal(info, null);
    assert.equal(called, false);
  });

  it("retries on 429 using retryAfterSeconds JSON field", async () => {
    let attempts = 0;
    const slept = [];
    const client = new VRChatApiClient({
      proxyUrl: "https://proxy.example.com",
      authToken: "secret_token",
      sleepFn: async (ms) => slept.push(ms),
      fetchImpl: async () => {
        attempts++;
        if (attempts === 1) {
          return new Response(JSON.stringify({ retryAfterSeconds: 4 }), { status: 429 });
        }
        return new Response(
          JSON.stringify({ id: "wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6", unityPackages: [{ platform: "android" }] }),
          { status: 200 }
        );
      },
    });

    const info = await client.getWorldInfo("wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6");
    assert.equal(info.unityPackages[0].platform, "android");
    assert.equal(attempts, 2);
    assert.deepEqual(slept, [4000]);
  });

  it("returns null gracefully after max retries on network errors", async () => {
    let attempts = 0;
    const client = new VRChatApiClient({
      proxyUrl: "https://proxy.example.com",
      authToken: "secret_token",
      sleepFn: async () => {},
      fetchImpl: async () => {
        attempts++;
        throw new Error("connection reset");
      },
    });

    const info = await client.getWorldInfo("wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6");
    assert.equal(info, null);
    assert.equal(attempts, 4);
  });
});

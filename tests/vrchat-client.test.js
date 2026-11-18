const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  VRChatApiClient,
  sanitizeProxyBaseUrl,
  resolveProxyAuthToken,
} = require("../src/vrchat-client");

describe("VRChatApiClient", () => {
  it("skips requests when proxy is not configured or token contains control chars", async () => {
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

    const badTokenClient = new VRChatApiClient({
      proxyUrl: "https://proxy.example.com",
      authToken: "bad\r\ntoken",
    });
    assert.equal(badTokenClient.isConfigured(), false);
  });

  it("enforces https:// and rejects credentials, query, hash, or non-string proxy URLs", () => {
    assert.equal(sanitizeProxyBaseUrl("http://remote-proxy.example.com"), "");
    assert.equal(sanitizeProxyBaseUrl("http://localhost:8080/"), "http://localhost:8080");
    assert.equal(sanitizeProxyBaseUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
    assert.equal(sanitizeProxyBaseUrl("http://[::1]:8080/"), "http://[::1]:8080");
    assert.equal(sanitizeProxyBaseUrl("https://proxy.example.com/v2/"), "https://proxy.example.com/v2");
    assert.equal(sanitizeProxyBaseUrl("https://user:pass@proxy.example.com"), "");
    assert.equal(sanitizeProxyBaseUrl("https://proxy.example.com/?a=1"), "");
    assert.equal(sanitizeProxyBaseUrl("https://proxy.example.com/#frag"), "");
    assert.equal(sanitizeProxyBaseUrl("not-a-url"), "");
    assert.equal(sanitizeProxyBaseUrl(null), "");
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
    const info = await client.getWorldInfo("../admin\r\n::error::inject");
    assert.equal(info, null);
    assert.equal(called, false);
  });

  it("sends Bearer Authorization header and redirect: error", async () => {
    let capturedInit = null;
    const client = new VRChatApiClient({
      proxyUrl: "https://proxy.example.com",
      authToken: "my_secret_token",
      fetchImpl: async (_url, init) => {
        capturedInit = init;
        return new Response(JSON.stringify({ id: "wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6" }), {
          status: 200,
        });
      },
    });

    await client.getWorldInfo("wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6");
    assert.equal(capturedInit.redirect, "error");
    assert.equal(capturedInit.headers.Authorization, "Bearer my_secret_token");
  });

  it("retries on 429 using retryAfterSeconds JSON field or Retry-After header", async () => {
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
        if (attempts === 2) {
          return new Response("too many requests", { status: 429, headers: { "Retry-After": "7" } });
        }
        return new Response(
          JSON.stringify({ id: "wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6", unityPackages: [{ platform: "android" }] }),
          { status: 200 }
        );
      },
    });

    const info = await client.getWorldInfo("wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6");
    assert.equal(info.unityPackages[0].platform, "android");
    assert.equal(attempts, 3);
    assert.deepEqual(slept, [4000, 7000]);
  });

  it("does not retry on 404/500 and returns null when 429 exceeds maxRetries", async () => {
    let notFoundAttempts = 0;
    const client404 = new VRChatApiClient({
      proxyUrl: "https://proxy.example.com",
      authToken: "secret_token",
      fetchImpl: async () => {
        notFoundAttempts++;
        return new Response("not found", { status: 404 });
      },
    });
    assert.equal(await client404.getWorldInfo("wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6"), null);
    assert.equal(notFoundAttempts, 1);

    let rateLimitAttempts = 0;
    const client429 = new VRChatApiClient({
      proxyUrl: "https://proxy.example.com",
      authToken: "secret_token",
      sleepFn: async () => {},
      fetchImpl: async () => {
        rateLimitAttempts++;
        return new Response(JSON.stringify({ retryAfterSeconds: 1 }), { status: 429 });
      },
    });
    assert.equal(await client429.getWorldInfo("wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6"), null);
    assert.equal(rateLimitAttempts, 4);
  });

  it("resolves auth token safely across direct, JSON, whitespace, null, and invalid inputs", () => {
    assert.equal(resolveProxyAuthToken(), "");
    assert.equal(resolveProxyAuthToken(null), "");
    assert.equal(
      resolveProxyAuthToken({
        authToken: "direct_tok",
        proxyTokensJson: '{"API_AUTH_TOKEN":"json_tok"}',
      }),
      "direct_tok"
    );
    assert.equal(
      resolveProxyAuthToken({
        authToken: "   ",
        proxyTokensJson: '{"API_AUTH_TOKEN":"  json_tok  "}',
      }),
      "json_tok"
    );
    assert.equal(
      resolveProxyAuthToken({
        authToken: "",
        proxyTokensJson: "null",
      }),
      ""
    );
    assert.equal(
      resolveProxyAuthToken({
        authToken: "",
        proxyTokensJson: '{"API_AUTH_TOKEN": 12345}',
      }),
      ""
    );
    assert.equal(
      resolveProxyAuthToken({
        authToken: "",
        proxyTokensJson: '{"API_AUTH_TOKEN":"bad\\ntok"}',
      }),
      ""
    );
    assert.equal(
      resolveProxyAuthToken({
        authToken: "",
        proxyTokensJson: "{invalid json",
      }),
      ""
    );
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

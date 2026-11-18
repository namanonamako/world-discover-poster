const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { UrlExpander, isSafeExternalUrl, extractMetaRefreshUrl } = require("../src/url-expander");

describe("UrlExpander & SSRF guard", () => {
  it("blocks localhost, private IPs, metadata IPs, credentials, and IPv6 bypass notations", async () => {
    const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
    assert.equal(await isSafeExternalUrl("http://localhost:8080/test", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://127.0.0.1/test", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://169.254.169.254/latest/meta-data/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://10.0.0.1/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://100.64.0.1/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://172.16.0.1/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://192.168.1.1/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://198.18.0.1/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://[::1]/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://[0:0:0:0:0:0:0:1]/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://[::ffff:127.0.0.1]/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://[::127.0.0.1]/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://[64:ff9b::127.0.0.1]/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://[fc00::1]/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://[fe80::1]/", publicDns), false);
    assert.equal(await isSafeExternalUrl("http://[ff02::1]/", publicDns), false);
    assert.equal(await isSafeExternalUrl("https://user:pass@example.com/", publicDns), false);
    assert.equal(await isSafeExternalUrl("https://metadata.internal/x", publicDns), false);
    assert.equal(await isSafeExternalUrl("file:///etc/passwd", publicDns), false);
    assert.equal(await isSafeExternalUrl("javascript:alert(1)", publicDns), false);

    // DNS がプライベート IP (IPv6非正規やIPv4) を返した場合もブロック
    assert.equal(
      await isSafeExternalUrl("https://evil.example.com", async () => [
        { address: "0:0:0:0:0:0:0:1", family: 6 },
      ]),
      false
    );
    assert.equal(
      await isSafeExternalUrl("https://evil.example.com", async () => [
        { address: "::ffff:169.254.169.254", family: 6 },
      ]),
      false
    );

    // パブリック IP 解決なら許可
    assert.equal(await isSafeExternalUrl("https://t.co/abc", publicDns), true);
  });

  it("extracts URL only from meta refresh tags and ignores unrelated url= attributes", () => {
    const decoyHtml = '<div data-url="https://evil.example.com">?next_url=https://bad.example.com</div>';
    assert.equal(extractMetaRefreshUrl(decoyHtml), null);

    const refreshHtml =
      '<html><head><META http-equiv="refresh" content="0;URL=\'https://vrchat.com/home/world/wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6\'"></head></html>';
    assert.equal(
      extractMetaRefreshUrl(refreshHtml),
      "https://vrchat.com/home/world/wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6"
    );
  });

  it("does not invoke fetchImpl for blocked SSRF URLs or redirect chains to private IPs", async () => {
    const fetchedUrls = [];
    const expander = new UrlExpander({
      fetchImpl: async (url) => {
        fetchedUrls.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      },
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    const result = await expander.expand("https://short.example.com/1");
    assert.equal(result, "http://169.254.169.254/latest/meta-data/");
    assert.deepEqual(fetchedUrls, ["https://short.example.com/1"]);
  });

  it("expands 3xx redirects and meta refresh HTML", async () => {
    const responses = {
      "https://short.example.com/1": new Response(null, {
        status: 302,
        headers: { location: "https://mid.example.com/2" },
      }),
      "https://mid.example.com/2": new Response(
        '<html><head><META http-equiv="refresh" content="0;URL=\'https://vrchat.com/home/world/wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6\'"></head></html>',
        { status: 200, headers: { "content-type": "TEXT/HTML; charset=utf-8" } }
      ),
      "https://vrchat.com/home/world/wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6": new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    };

    const expander = new UrlExpander({
      fetchImpl: async (url) => responses[url],
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    const expanded = await expander.expand("https://short.example.com/1");
    assert.equal(expanded, "https://vrchat.com/home/world/wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6");
  });
});

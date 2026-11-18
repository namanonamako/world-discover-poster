const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isAllowedEmbedRequestUrl,
  isValidOembedHtml,
  decodeHtmlEntities,
  sanitizeConsoleText,
} = require("../src/embed-guard");

describe("embed-guard", () => {
  it("allows only about:blank and https X/Twitter embed domains", () => {
    assert.equal(isAllowedEmbedRequestUrl("about:blank"), true);
    assert.equal(isAllowedEmbedRequestUrl("https://platform.x.com/widgets.js"), true);
    assert.equal(isAllowedEmbedRequestUrl("https://platform.twitter.com/widgets.js"), true);
    assert.equal(isAllowedEmbedRequestUrl("https://pbs.twimg.com/media/abc.jpg"), true);
    assert.equal(isAllowedEmbedRequestUrl("https://syndication.twitter.com/i/jot"), true);
    assert.equal(isAllowedEmbedRequestUrl("https://x.com/user/status/1"), true);

    assert.equal(isAllowedEmbedRequestUrl("http://platform.twitter.com/widgets.js"), false);
    assert.equal(isAllowedEmbedRequestUrl("http://169.254.169.254/latest/meta-data/"), false);
    assert.equal(isAllowedEmbedRequestUrl("https://127.0.0.1/test"), false);
    assert.equal(isAllowedEmbedRequestUrl("https://evil.example.com/steal.js"), false);
    assert.equal(isAllowedEmbedRequestUrl("https://twitter.com.evil.com/steal.js"), false);
    assert.equal(isAllowedEmbedRequestUrl("https://user:pass@x.com/user/status/1"), false);
    assert.equal(isAllowedEmbedRequestUrl("https://platform.twitter.com./widgets.js"), true);
    assert.equal(isAllowedEmbedRequestUrl("https://x.com:8443/user/status/1"), false);
    assert.equal(isAllowedEmbedRequestUrl("https://[::1]/test"), false);
    assert.equal(isAllowedEmbedRequestUrl("file:///etc/passwd"), false);
  });

  it("validates real publish.x.com and publish.twitter.com oEmbed HTML without false positives", () => {
    const validRealX =
      '<blockquote class="twitter-tweet" data-theme="light"><p lang="en" dir="ltr"><a href="https://x.com/hashtag/VRChat?src=hash&amp;ref_src=twsrc%5Etfw">#VRChat</a> World<br><br>Release data: v1 version=2 on=true<a href="https://t.co/Vvgvi0Xtok">https://t.co/Vvgvi0Xtok</a></p>&mdash; Studio JAW (@StudioJAW_X) <a href="https://x.com/StudioJAW_X/status/2122901798629630424?ref_src=twsrc%5Etfw">November 18, 2026</a></blockquote>\n<script async src="https://platform.x.com/widgets.js" charset="utf-8"></script>\n\n';
    const validTwitter =
      '<blockquote class="twitter-tweet"><p>Hello</p></blockquote><script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>';

    const withQuotedGtAndTrailingBool =
      '<blockquote class="twitter-tweet"><a data-x="a>b" href="https://x.com">x</a></blockquote><script src="https://platform.x.com/widgets.js" async></script>';

    assert.equal(isValidOembedHtml(validRealX), true);
    assert.equal(isValidOembedHtml(validTwitter), true);
    assert.equal(isValidOembedHtml(withQuotedGtAndTrailingBool), true);
  });

  it("rejects XSS bypasses, disallowed tags, DOM clobbering, and ReDoS inputs", () => {
    assert.equal(isValidOembedHtml("<div>not a tweet</div>"), false);
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"></blockquote><script>alert(1)</script>'),
      false
    );
    assert.equal(
      isValidOembedHtml(
        '<blockquote class="twitter-tweet"></blockquote><script src="https://evil.example.com/x.js"></script>'
      ),
      false
    );
    assert.equal(
      isValidOembedHtml(
        '<blockquote class="twitter-tweet"></blockquote><script data-src="https://platform.x.com/widgets.js" src="https://evil.example.com/x.js"></script>'
      ),
      false
    );
    assert.equal(
      isValidOembedHtml(
        '<blockquote class="twitter-tweet"></blockquote><script src="https://platform.x.com/widgets.js"onload="alert(1)"></script>'
      ),
      false
    );
    assert.equal(
      isValidOembedHtml(
        '<blockquote class="twitter-tweet"><x-a autofocus tabindex="0" onfocus="alert(1)"></x-a></blockquote>'
      ),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"><img src="x"onerror="alert(1)"></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"><img title=">" onerror="alert(1)" src="x"></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml(
        '<blockquote class="twitter-tweet"><a data-x=">" onclick="alert(1)" href="https://x.com">x</a></blockquote>'
      ),
      false
    );
    assert.equal(
      isValidOembedHtml(
        '<blockquote class="twitter-tweet"></blockquote><script async/src="https://platform.x.com/widgets.js"></script>'
      ),
      false
    );
    assert.equal(
      isValidOembedHtml(
        '<blockquote class="twitter-tweet"></blockquote><script src="https://platform.x.com/widgets.js">'
      ),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"><a href=https://x.com`foo`>x</a></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"><a href="javascript&#58;alert(1)">x</a></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"><a href="java&#x0a;script:alert(1)">x</a></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"><style>body{display:none}</style></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"><math></math></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote id="twitter-widget-0" class="twitter-tweet"></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml(
        '<blockquote class="twitter-tweet"></blockquote><iframe src="http://169.254.169.254"></iframe>'
      ),
      false
    );

    // O(N) ReDoS 耐性確認: 大量の未閉鎖 <script> が即座に false を返すこと
    const start = Date.now();
    const redosInput = '<blockquote class="twitter-tweet"></blockquote>' + "<script>".repeat(50000);
    assert.equal(isValidOembedHtml(redosInput), false);
    assert.ok(Date.now() - start < 500, "ReDoS check took too long");
  });

  it("decodes HTML entities safely including leading zeros, hex, and invalid surrogates", () => {
    assert.equal(decodeHtmlEntities("javascript&#0000058;alert(1)"), "javascript:alert(1)");
    assert.equal(decodeHtmlEntities("java&#X0a;script&colon;alert(1)"), "java\nscript:alert(1)");
    assert.equal(decodeHtmlEntities("&#xD800;&#0;"), "\uFFFD\uFFFD");
  });

  it("sanitizes console output against workflow command injection", () => {
    assert.equal(sanitizeConsoleText("::error::injected\nnext"), ": :error::injected next");
    assert.equal(sanitizeConsoleText("  ::add-mask::secret\r\n"), "  : :add-mask::secret  ");
  });
});

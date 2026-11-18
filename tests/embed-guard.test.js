const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isAllowedEmbedRequestUrl,
  isValidOembedHtml,
  sanitizeConsoleText,
} = require("../src/embed-guard");

describe("embed-guard", () => {
  it("allows only about:blank and https X/Twitter embed domains", () => {
    assert.equal(isAllowedEmbedRequestUrl("about:blank"), true);
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
    assert.equal(isAllowedEmbedRequestUrl("file:///etc/passwd"), false);
  });

  it("validates oEmbed HTML and rejects inline/data-src bypasses, event handlers, and dangerous tags", () => {
    const valid =
      '<blockquote class="twitter-tweet"><p>Hello</p></blockquote><script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>';
    assert.equal(isValidOembedHtml(valid), true);

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
        '<blockquote class="twitter-tweet"></blockquote><script data-src="https://platform.twitter.com/widgets.js" src="https://evil.example.com/x.js"></script>'
      ),
      false
    );
    assert.equal(
      isValidOembedHtml(
        '<blockquote class="twitter-tweet"></blockquote><script src="https://platform.twitter.com/widgets.js" onload="alert(1)"></script>'
      ),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"><img src="x" onerror="alert(1)"></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"><img/onerror="alert(1)" src="x"></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml('<blockquote class="twitter-tweet"><svg onload="alert(1)"></svg></blockquote>'),
      false
    );
    assert.equal(
      isValidOembedHtml(
        '<blockquote class="twitter-tweet"></blockquote><iframe src="http://169.254.169.254"></iframe>'
      ),
      false
    );
  });

  it("sanitizes console output against workflow command injection", () => {
    assert.equal(sanitizeConsoleText("::error::injected\nnext"), ": :error::injected next");
    assert.equal(sanitizeConsoleText("  ::add-mask::secret\r\n"), "  : :add-mask::secret  ");
  });
});

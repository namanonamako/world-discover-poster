const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { WorldIdExtractor } = require("../src/world-id-extractor");

describe("WorldIdExtractor", () => {
  it("extracts worldId directly from expandedUrls without calling UrlExpander", async () => {
    let expandCalled = false;
    const mockExpander = {
      expand: async () => {
        expandCalled = true;
        return "";
      },
    };
    const extractor = new WorldIdExtractor(mockExpander);
    const id = await extractor.extract({
      text: "Check out https://t.co/xyz",
      expandedUrls: [
        "https://vrchat.com/home/world/wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6",
      ],
    });

    assert.equal(id, "wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6");
    assert.equal(expandCalled, false);
  });

  it("extracts worldId from /home/launch?worldId=... (with or without trailing slash) and normalizes uppercase", async () => {
    const extractor = new WorldIdExtractor({ expand: async (u) => u });
    const id = await extractor.extract({
      expandedUrls: [
        "not-a-url",
        "ftp://vrchat.com/home/world/wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6",
        "https://vrchat.com/home/launch/?worldId=WRLD_3F6F0B96-C638-408F-8D55-79DF1FB3B1B6&instanceId=123",
      ],
    });
    assert.equal(id, "wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6");
  });

  it("rejects non-vrchat.com hostnames even if path contains /home/world/", async () => {
    const extractor = new WorldIdExtractor({ expand: async (u) => u });
    const id = await extractor.extract({
      expandedUrls: [
        "https://evil.example.com/home/world/wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6",
        "https://notvrchat.com/home/launch?worldId=wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6",
      ],
    });
    assert.equal(id, "");
  });

  it("trims trailing punctuation and falls back to UrlExpander", async () => {
    const expandedInputs = [];
    const mockExpander = {
      expand: async (url) => {
        expandedInputs.push(url);
        return url === "https://t.co/abcde"
          ? "https://vrchat.com/home/world/wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6"
          : url;
      },
    };
    const extractor = new WorldIdExtractor(mockExpander);
    const id = await extractor.extract({ text: "Cool world! (https://t.co/abcde)。" });
    assert.equal(id, "wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6");
  });

  it("returns empty string when no VRChat world link is present", async () => {
    const extractor = new WorldIdExtractor({ expand: async (u) => u });
    const id = await extractor.extract({ text: "No world link here" });
    assert.equal(id, "");
  });
});

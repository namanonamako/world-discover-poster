const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadState, saveState, pruneWorldCache, getMaxTweetId } = require("../src/state-manager");

describe("state-manager", () => {
  it("prunes expired and invalid worldCache entries", () => {
    const now = 1_700_000_000_000;
    const validId = "wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6";
    const expiredId = "wrld_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    const pruned = pruneWorldCache(
      {
        [validId]: { hasQuest: true, expireAt: now + 10000 },
        [expiredId]: { hasQuest: false, expireAt: now - 1 },
        invalid_key: { hasQuest: true, expireAt: now + 10000 },
      },
      now
    );

    assert.deepEqual(pruned, {
      [validId]: { hasQuest: true, expireAt: now + 10000 },
    });
  });

  it("saves and loads state safely", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-state-test-"));
    const statePath = path.join(tmpDir, "posterState.json");
    const now = 1_700_000_000_000;
    const worldId = "wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6";

    saveState(
      statePath,
      {
        lastTweetId: "1998234567890123456",
        worldCache: {
          [worldId]: { hasQuest: true, expireAt: now + 50000 },
        },
      },
      now
    );

    const loaded = loadState(statePath, now);
    assert.equal(loaded.lastTweetId, "1998234567890123456");
    assert.deepEqual(loaded.worldCache, {
      [worldId]: { hasQuest: true, expireAt: now + 50000 },
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("computes max tweet ID using BigInt comparison", () => {
    const maxId = getMaxTweetId("999999999999999999", [
      { id: "1000000000000000001" },
      { id: "1000000000000000000" },
      { id: "invalid" },
    ]);
    assert.equal(maxId, "1000000000000000001");
  });
});

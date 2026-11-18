const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadState,
  saveState,
  pruneWorldCache,
  getMaxTweetId,
  applyStateOverrides,
  shouldPreserveLastTweetId,
  buildStatePreservingLastTweetId,
} = require("../src/state-manager");

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

  it("resets lastTweetId while preserving worldCache when override is enabled", () => {
    const now = 1_700_000_000_000;
    const worldId = "wrld_3f6f0b96-c638-408f-8d55-79df1fb3b1b6";
    const baseState = {
      version: 1,
      lastTweetId: "2122910167104987475",
      lastUpdatedAt: "2026-11-18T05:31:13.278Z",
      worldCache: {
        [worldId]: { hasQuest: true, expireAt: now + 50000 },
      },
    };

    assert.deepEqual(applyStateOverrides(baseState, { resetLastTweetId: false }), baseState);
    const overridden = applyStateOverrides(baseState, { resetLastTweetId: true });
    assert.deepEqual(overridden, {
      ...baseState,
      lastTweetId: null,
    });
    assert.equal(baseState.lastTweetId, "2122910167104987475");
  });

  it("preserves previous lastTweetId and merges worldCache only on total capture failure", () => {
    assert.equal(shouldPreserveLastTweetId(), false);
    assert.equal(shouldPreserveLastTweetId({ targetCount: 37, capturedCount: 0, errorCount: 37 }), true);
    assert.equal(shouldPreserveLastTweetId({ targetCount: 5, capturedCount: 0, errorCount: 2 }), true);
    assert.equal(shouldPreserveLastTweetId({ targetCount: 37, capturedCount: 1, errorCount: 36 }), false);
    assert.equal(shouldPreserveLastTweetId({ targetCount: 5, capturedCount: 0, errorCount: 0 }), false);
    assert.equal(shouldPreserveLastTweetId({ targetCount: 0, capturedCount: 0, errorCount: 0 }), false);

    const now = 1_700_000_000_000;
    const w1 = "wrld_11111111-1111-1111-1111-111111111111";
    const w2 = "wrld_22222222-2222-2222-2222-222222222222";
    const expired = "wrld_33333333-3333-3333-3333-333333333333";
    const preserved = buildStatePreservingLastTweetId(
      {
        lastTweetId: "2122800000000000000",
        worldCache: {
          [w1]: { hasQuest: false, expireAt: now + 10000 },
          [expired]: { hasQuest: true, expireAt: now - 1 },
        },
      },
      {
        lastTweetId: "2122910167104987475",
        worldCache: {
          [w1]: { hasQuest: true, expireAt: now + 30000 },
          [w2]: { hasQuest: true, expireAt: now + 20000 },
        },
      },
      now
    );

    assert.equal(preserved.lastTweetId, "2122800000000000000");
    assert.deepEqual(preserved.worldCache, {
      [w1]: { hasQuest: true, expireAt: now + 30000 },
      [w2]: { hasQuest: true, expireAt: now + 20000 },
    });

    const withoutPrev = buildStatePreservingLastTweetId(null, {
      lastTweetId: "2122910167104987475",
      worldCache: { [w2]: { hasQuest: true, expireAt: now + 20000 } },
    }, now);
    assert.equal(withoutPrev.lastTweetId, null);
    assert.deepEqual(withoutPrev.worldCache, { [w2]: { hasQuest: true, expireAt: now + 20000 } });
  });
});

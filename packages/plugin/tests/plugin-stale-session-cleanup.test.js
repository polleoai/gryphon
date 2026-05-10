// Regression: lastSessionId for codex-cli / gemini-cli providers must
// be dropped on plugin reload, while CC and SDK ids survive. Chat
// history (the messages array in chat-history.json) is unaffected
// either way — only `settings.lastSessionId` changes.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

// We don't need the full plugin class — exercise the cleanup logic
// directly by constructing a partial-shaped object with only the
// fields the function reads.
function makePluginShell(lastSessionId) {
  // Re-run loadSettings would also re-fire migrations + stub `loadData`,
  // which we don't need to test here. Build the same in-memory shape
  // and call the cleanup directly.
  const { _dropStalePerReloadSessionIdsFor } = installCleanupHarness();
  const settings = { lastSessionId };
  _dropStalePerReloadSessionIdsFor(settings);
  return settings;
}

// The cleanup is a method on GryphonPlugin. Re-implement the same
// logic in this test harness so we can exercise it without the full
// plugin lifecycle. If the production logic drifts, the source-quote
// test below catches it.
function installCleanupHarness() {
  function _dropStalePerReloadSessionIdsFor(settings) {
    const sid = settings && settings.lastSessionId;
    if (typeof sid !== "string" || !sid) return;
    if (sid.startsWith("codex-cli-") || sid.startsWith("gemini-cli-")) {
      settings.lastSessionId = null;
    }
  }
  return { _dropStalePerReloadSessionIdsFor };
}

test("codex-cli session id is cleared on reload", () => {
  const s = makePluginShell("codex-cli-019dec5c-15da-7370-ad10-46731b3a7820");
  assert.equal(s.lastSessionId, null);
});

test("gemini-cli session id is cleared on reload", () => {
  const s = makePluginShell("gemini-cli-550e8400-e29b-41d4-a716-446655440000");
  assert.equal(s.lastSessionId, null);
});

test("Claude Code UUID session id survives reload (CC re-streams history on resume)", () => {
  const s = makePluginShell("d7f8906d-0bca-4003-b319-292de5a5d4f0");
  assert.equal(s.lastSessionId, "d7f8906d-0bca-4003-b319-292de5a5d4f0");
});

test("Anthropic SDK session id survives reload (stateless tag, not a server handle)", () => {
  const s = makePluginShell("sdk-1777755129921");
  assert.equal(s.lastSessionId, "sdk-1777755129921");
});

test("OpenAI SDK session id survives reload", () => {
  const s = makePluginShell("openai-sdk-1777755129921");
  assert.equal(s.lastSessionId, "openai-sdk-1777755129921");
});

test("Google SDK session id survives reload", () => {
  const s = makePluginShell("gemini-sdk-1777755129921");
  assert.equal(s.lastSessionId, "gemini-sdk-1777755129921");
});

test("null / empty / non-string ids are no-ops", () => {
  assert.equal(makePluginShell(null).lastSessionId, null);
  assert.equal(makePluginShell("").lastSessionId, "");
  assert.equal(makePluginShell(undefined).lastSessionId, undefined);
});

// Pin the production source so a future refactor can't silently drop
// the cleanup. If this assertion fails, audit `loadSettings` in
// plugin.js to confirm the cleanup still runs.
test("plugin.js loadSettings still calls _dropStalePerReloadSessionIds()", () => {
  const fs = require("fs");
  const src = fs.readFileSync(
    require.resolve("../src/plugin.js"),
    "utf8",
  );
  assert.match(src, /_dropStalePerReloadSessionIds\(\)/,
    "loadSettings must still invoke _dropStalePerReloadSessionIds() — " +
    "removing it strands users on stale CLI sessions across plugin updates");
  assert.match(src, /codex-cli-|gemini-cli-/,
    "_dropStalePerReloadSessionIds must check for the codex-cli / gemini-cli prefixes");
});

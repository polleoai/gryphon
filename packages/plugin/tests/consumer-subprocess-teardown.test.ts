/**
 * Consumer subprocess teardown — the embedding-consumer contract.
 *
 * An embedding host app that embeds GryphonChatView and changes a
 * spawn-time setting (providerPreference / model / effort / permissionMode)
 * through its OWN settings tab fires `gryphon:settings-changed` but does NOT
 * call Gryphon's imperative `_resetActiveSessions()`. Before this fix, the
 * chat-view's settings-changed listener only refreshed UI — it never tore
 * down the live provider subprocess. So switching Claude → Codex/Gemini
 * mid-session kept talking to the still-alive Claude process.
 *
 * The fix moves subprocess ownership behind the event: the chat-view stamps
 * a spawn-time signature on each createProvider, and on settings-changed it
 * tears down the live process when that signature no longer matches current
 * settings. The reuse guard is hardened the same way.
 *
 * Tested via direct method invocation with minimal stubs (the same pattern
 * as settings-changed-event.test.ts), since the full view pulls in heavy
 * Obsidian deps.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { GryphonChatView } = require("../src/chat-view");

/**
 * Build a stub view with a live (alive) provider stamped with a known
 * spawn signature. `_computeProviderSignature` is overridden to return
 * `current` so the test controls the "want" side without exercising
 * getActiveProviderKind / key availability.
 */
function makeStubView({ spawnSignature, current }) {
  const view = Object.create(GryphonChatView.prototype);
  const aborts = [];
  const systemMessages = [];
  view.claudeProcess = {
    _alive: true,
    isAlive() { return this._alive; },
    abort() { this._alive = false; aborts.push(true); },
  };
  view._providerSpawnSignature = spawnSignature;
  view._computeProviderSignature = () => current;
  view.addSystemMessage = (m) => { systemMessages.push(m); };
  view._aborts = aborts;
  view._systemMessages = systemMessages;
  return view;
}

test("settings-changed teardown aborts the live process when provider kind changes", () => {
  const view = makeStubView({
    spawnSignature: { kind: "claude-code", model: "sonnet", effort: "high", permissionMode: "default" },
    current: { kind: "codex-cli", model: "sonnet", effort: "high", permissionMode: "default" },
  });

  view._teardownLiveProcessIfSettingsChanged();

  assert.equal(view._aborts.length, 1, "live process should be aborted on provider switch");
  assert.equal(view.claudeProcess, null, "claudeProcess should be nulled after teardown");
  assert.equal(view._providerSpawnSignature, null, "spawn signature should be cleared");
  assert.ok(
    view._systemMessages.some((m) => /takes effect on next message/i.test(m)),
    "should surface the 'takes effect on next message' notice",
  );
});

test("settings-changed teardown aborts on model change", () => {
  const view = makeStubView({
    spawnSignature: { kind: "claude-code", model: "sonnet", effort: "high", permissionMode: "default" },
    current: { kind: "claude-code", model: "opus", effort: "high", permissionMode: "default" },
  });

  view._teardownLiveProcessIfSettingsChanged();

  assert.equal(view._aborts.length, 1, "model change should tear down the live process");
  assert.equal(view.claudeProcess, null);
});

test("settings-changed teardown is a no-op when the spawn signature is unchanged", () => {
  const sig = { kind: "codex-cli", model: "gpt-5.5", effort: "medium", permissionMode: "default" };
  const view = makeStubView({
    spawnSignature: { ...sig },
    current: { ...sig },
  });

  view._teardownLiveProcessIfSettingsChanged();

  assert.equal(view._aborts.length, 0, "an unrelated settings change must not kill the live process");
  assert.ok(view.claudeProcess, "claudeProcess should survive when nothing spawn-relevant changed");
});

test("teardown is safe when there is no live process", () => {
  const view = Object.create(GryphonChatView.prototype);
  view.claudeProcess = null;
  view._providerSpawnSignature = null;
  view._computeProviderSignature = () => ({ kind: "claude-code" });
  assert.doesNotThrow(() => view._teardownLiveProcessIfSettingsChanged());
});

test("teardown is a no-op when the process already died (no stamp to compare)", () => {
  const view = Object.create(GryphonChatView.prototype);
  let aborted = false;
  view.claudeProcess = { isAlive: () => false, abort: () => { aborted = true; } };
  view._providerSpawnSignature = { kind: "claude-code", model: "sonnet", effort: null, permissionMode: null };
  view._computeProviderSignature = () => ({ kind: "codex-cli", model: "sonnet", effort: null, permissionMode: null });

  view._teardownLiveProcessIfSettingsChanged();

  assert.equal(aborted, false, "a dead process should not be aborted again");
  // The dead process is left for the send path to replace; we don't null it here.
});

test("_providerSignatureChanged detects a mismatch and ignores an unstamped process", () => {
  const view = Object.create(GryphonChatView.prototype);
  view.claudeProcess = { isAlive: () => true, abort: () => {} };

  // No stamp yet → cannot assert a mismatch → false (defensive: don't kill).
  view._providerSpawnSignature = null;
  view._computeProviderSignature = () => ({ kind: "codex-cli", model: "x", effort: null, permissionMode: null });
  assert.equal(view._providerSignatureChanged(), false, "unstamped process should not report a change");

  // Stamped + different → true.
  view._providerSpawnSignature = { kind: "claude-code", model: "x", effort: null, permissionMode: null };
  assert.equal(view._providerSignatureChanged(), true, "stamped + different kind should report a change");

  // Stamped + same → false.
  view._providerSpawnSignature = { kind: "codex-cli", model: "x", effort: null, permissionMode: null };
  assert.equal(view._providerSignatureChanged(), false, "stamped + identical signature should report no change");
});

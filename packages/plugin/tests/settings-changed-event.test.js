/**
 * Issue #40 — settings-changed reactive layer.
 *
 * Tests that:
 *   1. plugin.saveSettings() fires `gryphon:settings-changed` on the
 *      workspace bus after persisting (so listeners — including
 *      consumer plugins, not just GryphonChatView — can react).
 *   2. The trigger is fail-safe: missing app/workspace doesn't throw
 *      (so headless test environments and partial Obsidian shims work).
 *   3. refreshToolbarLabels updates ALL toolbar buttons (model, effort,
 *      permission), not just modelBtn — and is safe to call when any
 *      button reference is missing.
 *
 * The plugin and view classes pull in heavy Obsidian dependencies, so
 * we exercise the relevant code paths via direct method invocation
 * with minimal stubs rather than full instantiation.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Stub obsidian so plugin.js + chat-view.js can be required under
// node:test (matches the pattern used by other tests in this directory).
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

test("saveSettings fires gryphon:settings-changed after saveData", async () => {
  // Build a minimal plugin-like instance and call saveSettings via the
  // class definition (avoids constructing the real plugin which loads
  // many subsystems).
  const GryphonPlugin = require("../src/plugin");

  let saveDataCalls = 0;
  let triggerCalls = [];
  const stubPlugin = Object.create(GryphonPlugin.prototype);
  stubPlugin.settings = { model: "sonnet", providerPreference: "anthropic-api" };
  stubPlugin.saveData = async (data) => {
    saveDataCalls += 1;
    // saveData must complete BEFORE trigger fires. Capture order
    // via a flag we check after the trigger.
    stubPlugin._savedAt = saveDataCalls;
  };
  stubPlugin.app = {
    workspace: {
      trigger: (event, payload) => {
        triggerCalls.push({ event, payload, savedAtFireTime: stubPlugin._savedAt });
      },
    },
  };

  await stubPlugin.saveSettings();

  assert.equal(saveDataCalls, 1, "saveData should be called exactly once");
  assert.equal(triggerCalls.length, 1, "trigger should fire exactly once");
  assert.equal(triggerCalls[0].event, "gryphon:settings-changed");
  assert.equal(triggerCalls[0].payload, stubPlugin.settings);
  assert.equal(
    triggerCalls[0].savedAtFireTime, 1,
    "trigger must fire AFTER saveData completes (so listeners see persisted state)",
  );
});

test("saveSettings is fail-safe when app/workspace is missing", async () => {
  // Headless / test environments don't always provide app.workspace.
  // saveSettings must not throw in that case — settings persistence
  // is the priority; the event is best-effort.
  const GryphonPlugin = require("../src/plugin");

  const stubPlugin = Object.create(GryphonPlugin.prototype);
  stubPlugin.settings = {};
  stubPlugin.saveData = async () => { /* persist no-op */ };
  // No app at all
  await assert.doesNotReject(stubPlugin.saveSettings());

  // app present but no workspace
  stubPlugin.app = {};
  await assert.doesNotReject(stubPlugin.saveSettings());

  // workspace present but no trigger function
  stubPlugin.app = { workspace: {} };
  await assert.doesNotReject(stubPlugin.saveSettings());
});

test("refreshToolbarLabels updates model, effort, and permission badges", () => {
  // Construct a stub view with mock toolbar buttons + plugin settings.
  const { GryphonChatView } = require("../src/chat-view");

  const stubView = Object.create(GryphonChatView.prototype);

  // Mock plugin.settings with concrete values.
  stubView.plugin = {
    manifest: { version: "1.4.1" },
    settings: {
      model: "sonnet",
      effort: "high",
      permissionMode: "bypassPermissions",
      providerPreference: "anthropic-api",
      anthropicApiKey: "sk-test",
    },
  };

  // Mock the three toolbar buttons. setText / setAttribute / classList
  // capture invocations so we can assert what was set.
  const captures = { model: {}, effort: {}, perm: {} };
  function makeBtn(key) {
    const cls = new Set();
    return {
      setText: (s) => { captures[key].text = s; },
      setAttribute: (k, v) => { captures[key][k] = v; },
      classList: {
        toggle: (name, on) => {
          if (on) cls.add(name);
          else cls.delete(name);
          captures[key].classes = Array.from(cls);
        },
      },
    };
  }
  stubView.modelBtn = makeBtn("model");
  stubView.effortBtn = makeBtn("effort");
  stubView.permBtn = makeBtn("perm");

  stubView.refreshToolbarLabels();

  // Each button got its text refreshed.
  assert.ok(captures.model.text, "modelBtn text should be set");
  assert.ok(captures.model.text.includes("▾"), "modelBtn text should include caret");
  assert.ok(captures.effort.text, "effortBtn text should be set");
  assert.ok(captures.effort.text.includes("High"), "effortBtn should reflect 'high' setting");
  assert.ok(captures.perm.text, "permBtn text should be set");
  assert.ok(
    captures.perm.text.includes("YOLO"),
    "permBtn should show 'YOLO' label for bypassPermissions",
  );

  // YOLO mode toggles the highlight class on.
  assert.ok(
    captures.perm.classes && captures.perm.classes.includes("gryphon-perm-yolo"),
    "permBtn should have gryphon-perm-yolo class when bypassPermissions",
  );
});

test("refreshToolbarLabels removes YOLO class when permission mode changes away", () => {
  const { GryphonChatView } = require("../src/chat-view");
  const stubView = Object.create(GryphonChatView.prototype);
  stubView.plugin = {
    manifest: { version: "1.4.1" },
    settings: {
      model: "sonnet",
      effort: "high",
      permissionMode: "default",
      providerPreference: "anthropic-api",
      anthropicApiKey: "sk-test",
    },
  };
  stubView.modelBtn = null;  // tests "missing button" path
  stubView.effortBtn = null;
  let removedYolo = false;
  stubView.permBtn = {
    setText: () => {},
    setAttribute: () => {},
    classList: {
      toggle: (name, on) => {
        if (name === "gryphon-perm-yolo" && on === false) removedYolo = true;
      },
    },
  };

  stubView.refreshToolbarLabels();

  assert.ok(removedYolo, "permBtn should have YOLO class removed when mode is not bypassPermissions");
});

test("refreshToolbarLabels is safe when toolbar buttons haven't been created yet", () => {
  // onOpen builds the buttons; if refreshToolbarLabels is called
  // before onOpen (e.g., from a settings-change event that fires
  // before the first onOpen completes), the buttons are null. The
  // method must not throw.
  const { GryphonChatView } = require("../src/chat-view");
  const stubView = Object.create(GryphonChatView.prototype);
  stubView.plugin = {
    manifest: { version: "1.4.1" },
    settings: {
      model: "sonnet",
      effort: "low",
      permissionMode: "default",
      providerPreference: "anthropic-api",
      anthropicApiKey: "sk-test",
    },
  };
  // No buttons assigned at all
  assert.doesNotThrow(() => stubView.refreshToolbarLabels());
});

test("Round 4 SFH-3: saveSettings survives a listener that throws", async () => {
  // A buggy consumer plugin's listener should NOT propagate exceptions
  // up through saveSettings — the persisted data is already on disk;
  // a listener bug must not surface as "settings save failed."
  const GryphonPlugin = require("../src/plugin");

  const stubPlugin = Object.create(GryphonPlugin.prototype);
  stubPlugin.settings = { model: "sonnet" };
  stubPlugin.saveData = async () => { /* persist no-op */ };
  let triggered = false;
  stubPlugin.app = {
    workspace: {
      trigger: () => {
        triggered = true;
        throw new Error("listener exploded");
      },
    },
  };

  // saveSettings must not reject even though the trigger threw.
  await assert.doesNotReject(stubPlugin.saveSettings());
  assert.equal(triggered, true, "trigger handler should still have been invoked");
});

test("Round 4 SFH-2: chat-view warns on unknown extraProcessArgsByProvider keys", () => {
  // A typoed key (e.g. "claude_code" with underscore) silently no-op'd
  // the consumer's flags before — every spawn missed the consumer's
  // intended args with no diagnostic. Now the construction-time check
  // logs a console.error so the typo surfaces during integration test.
  const { GryphonChatView } = require("../src/chat-view");

  // Capture console.error invocations.
  const origError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args.join(" ")); };

  try {
    // Construct a stub view via the actual constructor path. ItemView
    // base class is a noop stub from _stubs/obsidian.js; what we care
    // about is the validation side-effect on options.
    const stubLeaf = { /* unused by validation */ };
    const stubPlugin = {
      manifest: { version: "1.4.x-test" },
      settings: { model: "sonnet" },
    };
    new GryphonChatView(stubLeaf, stubPlugin, {
      extraProcessArgsByProvider: {
        "claude_code": ["--allowedTools", "Bash"],   // typoed (underscore)
        "claudeCode":  ["--allowedTools", "Read"],   // typoed (camel)
        "claude-code": ["--allowedTools", "Edit"],   // correct — should NOT warn
      },
    });

    assert.equal(errors.length, 2, "should warn once per unknown key");
    assert.ok(
      errors.some((e) => e.includes("claude_code")),
      "warning should name the typoed key",
    );
    assert.ok(
      errors.some((e) => e.includes("claudeCode")),
      "warning should name the second typoed key",
    );
    // Correct key must NOT trigger a warning.
    assert.ok(
      !errors.some((e) => e.includes('"claude-code"')),
      "valid key should not produce a warning",
    );
  } finally {
    console.error = origError;
  }
});

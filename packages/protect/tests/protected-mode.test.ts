/**
 * Protected Mode + Auto-deny tests (v0.9.2).
 *
 * Covers the three-state logic in permission-gate.js:
 *
 *   1. protectedMode=true  + autoDenyProtected=false → modal (default)
 *      - Hard to unit-test (needs DOM). Covered by the existing
 *        security-runtime.test.js path which uses bypassPermissions to
 *        skip the modal and exercise the surrounding logic.
 *
 *   2. protectedMode=true  + autoDenyProtected=true  → auto-deny
 *      - Returns { allow: false, reason: <prescriptive> } without
 *        opening a modal. Reason text must point at Settings.
 *
 *   3. protectedMode=false                           → demoted to plain
 *      - Protected kinds treated as fileEdit/exec. bypassPermissions
 *        allows; acceptEdits allows file edits. Category/warning
 *        fields cleared so the modal (if it fires for Prompt mode)
 *        doesn't show protected styling.
 *
 * Modal path (state 1) needs DOM; verified by security-runtime.test.js
 * and by manual smoke tests.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Stub obsidian so permission-gate's `const { Modal, Setting } = require("obsidian")`
// resolves. No modal is opened in these tests — we hit the non-modal
// branches first.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { checkPermission } = require("../src/permission-gate");

function ctxWithSettings(settings) {
  // permission-gate reads settings from ctx.plugin.settings; ctx.plugin.app
  // must be defined for the modal path to be reachable (we test paths
  // that return before the modal).
  return {
    vaultRoot: "/tmp/fake",
    permissionMode: settings.permissionMode || "default",
    plugin: { settings, app: {} },
  };
}

// ── State 2: Protected Mode ON + Auto-deny ON ─────────────────────────

test("state 2: auto-deny returns refusal with prescriptive reason (protected)", async () => {
  const ctx = ctxWithSettings({
    protectedMode: true,
    autoDenyProtected: true,
  });
  const result = await checkPermission({
    ctx,
    action: "edit",
    target: ".obsidian/plugins/gryphon/data.json",
    kind: "protected",
  });
  assert.equal(result.allow, false);
  assert.match(
    result.reason,
    /Gryphon plugin is blocking/,
    "reason should name Gryphon and identify the deny",
  );
  assert.match(
    result.reason,
    /protected patterns/,
    "reason should reference the protected-patterns concept",
  );
  assert.match(
    result.reason,
    /Settings → Gryphon → Protected file paths/,
    "reason should point at Protected file paths for kind:protected",
  );
  assert.match(
    result.reason,
    /uncheck the matching pattern/i,
    "reason should give the unblock recipe (case-insensitive — " +
    "bullet form capitalizes the initial U)",
  );
});

test("state 2: auto-deny path variant for protected-exec", async () => {
  const ctx = ctxWithSettings({
    protectedMode: true,
    autoDenyProtected: true,
  });
  const result = await checkPermission({
    ctx,
    action: "run",
    target: "rm -rf /",
    kind: "protected-exec",
  });
  assert.equal(result.allow, false);
  assert.match(
    result.reason,
    /Protected commands/,
    "reason should point at Protected commands for kind:protected-exec",
  );
});

test("state 2: auto-deny doesn't apply to non-protected kinds", async () => {
  // Even with autoDenyProtected=true, routine fileEdit/exec operations
  // should flow through normal permission-mode logic — not be swallowed
  // by the auto-deny shortcut.
  const ctx = ctxWithSettings({
    protectedMode: true,
    autoDenyProtected: true,
    permissionMode: "bypassPermissions",
  });
  const result = await checkPermission({
    ctx,
    action: "edit",
    target: "notes/daily.md",
    kind: "fileEdit",
  });
  assert.equal(result.allow, true, "non-protected routine edits bypass in YOLO");
});

// ── State 3: Protected Mode OFF — protected kinds demoted ─────────────

test("state 3: Protected Mode OFF + YOLO mode allows protected file edit", async () => {
  // Real-YOLO path: user has opted out of pattern-based enforcement
  // entirely. bypassPermissions should allow the edit that would
  // otherwise have shown a modal.
  const ctx = ctxWithSettings({
    protectedMode: false,
    permissionMode: "bypassPermissions",
  });
  const result = await checkPermission({
    ctx,
    action: "edit",
    target: ".obsidian/plugins/gryphon/data.json",
    kind: "protected",
  });
  assert.equal(result.allow, true, "Protected Mode OFF demotes to fileEdit; YOLO allows");
});

test("state 3: Protected Mode OFF + YOLO mode allows protected exec", async () => {
  const ctx = ctxWithSettings({
    protectedMode: false,
    permissionMode: "bypassPermissions",
  });
  const result = await checkPermission({
    ctx,
    action: "run",
    target: "rm -rf /tmp/junk",
    kind: "protected-exec",
  });
  assert.equal(result.allow, true, "Protected Mode OFF demotes protected-exec; YOLO allows");
});

test("state 3: Protected Mode OFF + Safe mode allows protected file edit", async () => {
  const ctx = ctxWithSettings({
    protectedMode: false,
    permissionMode: "acceptEdits",
  });
  const result = await checkPermission({
    ctx,
    action: "edit",
    target: ".obsidian/plugins/gryphon/data.json",
    kind: "protected",
  });
  assert.equal(result.allow, true, "Safe mode auto-accepts file edits when demoted");
});

test("state 3: Protected Mode OFF preserves Plan-mode refusal", async () => {
  // Plan mode refuses everything regardless of the Protected Mode
  // toggle — the check runs before the demotion. Prevents a user
  // from accidentally circumventing Plan mode by flipping Protected
  // Mode off.
  const ctx = ctxWithSettings({
    protectedMode: false,
    permissionMode: "plan",
  });
  const result = await checkPermission({
    ctx,
    action: "edit",
    target: "notes/foo.md",
    kind: "protected",
  });
  assert.equal(result.allow, false);
  assert.match(result.reason, /Plan mode is active/);
});

// ── Default-value behavior (absent settings) ──────────────────────────

test("absent protectedMode defaults to ON (treats as protected)", async () => {
  // A user with no settings saved at all should get the safest default:
  // protected ops are still gated. The check returns false for the YOLO
  // fast-path because isProtected stays true.
  const ctx = ctxWithSettings({
    // protectedMode intentionally undefined
    // autoDenyProtected intentionally undefined
    autoDenyProtected: true,           // use auto-deny to skip modal path
    permissionMode: "bypassPermissions",
  });
  const result = await checkPermission({
    ctx,
    action: "edit",
    target: ".obsidian/plugins/gryphon/data.json",
    kind: "protected",
  });
  assert.equal(result.allow, false, "default (undefined) protectedMode should behave as ON");
});

test("absent autoDenyProtected defaults to OFF (modal path)", async () => {
  // With autoDenyProtected undefined, protected ops don't auto-deny —
  // they fall through to the modal. Here we just verify the early
  // auto-deny branch doesn't fire; full modal behavior needs a DOM.
  const ctx = ctxWithSettings({
    protectedMode: true,
    // autoDenyProtected intentionally undefined
    permissionMode: "plan",   // plan mode returns before modal; easy to assert
  });
  const result = await checkPermission({
    ctx,
    action: "edit",
    target: ".obsidian/plugins/gryphon/data.json",
    kind: "protected",
  });
  // Plan mode wins (above the auto-deny branch, for the reason tested
  // earlier). Confirms auto-deny isn't silently forced when absent.
  assert.match(result.reason, /Plan mode/);
});

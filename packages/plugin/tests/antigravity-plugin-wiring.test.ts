/**
 * Issue #19 — plugin-shell wiring for the antigravity-cli provider.
 *
 * The provider itself (spawn, event parsing, binary resolution) lives in
 * provider-runtime and is covered by its own suites. This file pins the
 * *shell* half: unless every one of these holds, the provider exists but no
 * user can reach it — it isn't in the Provider dropdown, has no path field to
 * point at a non-standard `agy`, and falls through to Anthropic's model list
 * instead of Gemini's.
 *
 * The gap this file closes was real: v2.8.0's runtime shipped the provider
 * with zero plugin-package references to it.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.ts");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { _el, _allSettings } = require("./_stubs/obsidian.ts");
const { PROVIDER_PREFS, FALLBACK_PROVIDER_PREFS, DEFAULT_SETTINGS } = require("../src/constants");

const noopCtx = { rerenderSelf() {}, rerenderAll() {} };
const names = (panel) => _allSettings(panel).map((s) => s.name);

// ── Selectable at all ────────────────────────────────────────────────────

test("antigravity-cli is an option in the Provider dropdown", () => {
  const entry = PROVIDER_PREFS.find((p) => p.value === "antigravity-cli");
  assert.ok(entry, "PROVIDER_PREFS must contain antigravity-cli — without it the provider is unreachable");
  assert.ok(entry.label && entry.label.length > 0, "entry needs a dropdown label");
  assert.ok(entry.desc && entry.desc.length > 0, "entry needs a description");
});

test("antigravity-cli is offered as a failover target", () => {
  assert.ok(
    FALLBACK_PROVIDER_PREFS.some((p) => p.value === "antigravity-cli"),
    "FALLBACK_PROVIDER_PREFS derives from PROVIDER_PREFS, so this follows — pinned so a future split can't silently drop it",
  );
});

test("DEFAULT_SETTINGS carries an antigravityPath key", () => {
  assert.equal(
    DEFAULT_SETTINGS.antigravityPath, "",
    "factory.ts reads settings.antigravityPath; an absent default means the manual override can never persist",
  );
});

// ── Credential / path row ────────────────────────────────────────────────

test("_credentialFieldsFor maps antigravity-cli to its path field only", () => {
  const { _credentialFieldsFor } = require("../src/settings-view");
  assert.deepEqual(
    _credentialFieldsFor("antigravity-cli"), ["antigravityPath"],
    "agy owns its own auth (like codex-cli) — no Google API key row",
  );
});

test("antigravity-cli renders the Antigravity CLI path row, not a Google key row", () => {
  const host = { settings: { providerPreference: "antigravity-cli" }, saveSettings: async () => {} };
  const panel = _el();
  const { renderSetupPanel } = require("../src/settings-view");
  renderSetupPanel(host, panel, noopCtx);
  const n = names(panel);
  assert.ok(n.includes("Antigravity CLI path"));
  assert.ok(!n.includes("Google API key"), "auth is CLI-owned; a key field here would mislead");
  assert.ok(!n.includes("Anthropic API key"));
});

test("Antigravity CLI path row is on par with the other CLI rows (status pill + Re-detect)", () => {
  const host = { settings: { providerPreference: "antigravity-cli" }, saveSettings: async () => {} };
  const panel = _el();
  const { renderSetupPanel } = require("../src/settings-view");
  renderSetupPanel(host, panel, noopCtx);
  const row = _allSettings(panel).find((s) => s.name === "Antigravity CLI path");
  assert.ok(row, "row present");
  assert.ok(
    row.nameEl.__created.some((c) => c.cls === "gryphon-cli-status-pill"),
    "renders the detection status pill",
  );
  assert.ok(
    row.controls.filter((c) => c.type === "button").some((b) => b.buttonText === "Re-detect"),
    "has a Re-detect button",
  );
});

test("the collapsed all-credentials group (auto) includes the Antigravity path row", () => {
  const host = { settings: { providerPreference: "auto" }, saveSettings: async () => {} };
  const panel = _el();
  const { renderSetupPanel } = require("../src/settings-view");
  renderSetupPanel(host, panel, noopCtx);
  assert.ok(names(panel).includes("Antigravity CLI path"));
});

// ── Model list: antigravity is Gemini-backed ─────────────────────────────

test("antigravity-cli uses the Gemini model dropdown, not Anthropic's", () => {
  const { _resetModelForProvider } = require("../src/settings-view");
  const { getModelDropdownOptions } = require("@gryphon/provider-runtime").pricing.google;
  const geminiIds = getModelDropdownOptions().map((o) => o.id);
  // A stale cross-vendor id must be corrected to a Gemini id, not left as a
  // Claude one — otherwise the toolbar shows "claude-sonnet-5" while `agy`
  // is actually being spawned with a Gemini model.
  const resolved = _resetModelForProvider({
    settings: { providerPreference: "antigravity-cli", model: "claude-sonnet-5" },
  });
  assert.ok(
    geminiIds.includes(resolved),
    `antigravity-cli should resolve to a Gemini model, got ${resolved}`,
  );
});

test("_fallbackModelOptions offers Gemini models for antigravity-cli", () => {
  const { _fallbackModelOptions } = require("../src/settings-view");
  const opts = _fallbackModelOptions("antigravity-cli");
  const { getModelDropdownOptions } = require("@gryphon/provider-runtime").pricing.google;
  assert.deepEqual(
    opts.map((o) => o.id),
    getModelDropdownOptions().map((o) => o.id),
  );
});

test("toolbar Model button is brand-labelled Gemini for antigravity-cli", () => {
  const { modelButtonTitle } = require("../src/chat-view");
  assert.equal(modelButtonTitle({ providerPreference: "antigravity-cli" }), "Model (Gemini)");
});

// ── Known-kind registries ────────────────────────────────────────────────

test("antigravity-cli is a recognised provider kind in the chat-view label map", () => {
  const { _providerLabelFor } = require("../src/chat-view");
  assert.equal(
    _providerLabelFor("antigravity-cli"), "Antigravity CLI",
    "unknown kinds fall through to the raw string — the friendly label proves it's registered",
  );
});

test("extraProcessArgsByProvider accepts antigravity-cli as a valid key", () => {
  const src = require("node:fs").readFileSync(
    require.resolve("../src/chat-view.ts"), "utf8",
  );
  assert.match(
    src, /KNOWN_PROVIDER_KINDS[\s\S]{0,240}"antigravity-cli"/,
    "a per-provider extraArgs bucket keyed antigravity-cli must not be rejected as a typo",
  );
});

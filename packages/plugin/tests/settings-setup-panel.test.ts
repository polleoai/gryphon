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
const { renderSetupPanel } = require("../src/settings-view");

const noopCtx = { rerenderSelf() {}, rerenderAll() {} };
const names = (panel) => _allSettings(panel).map((s) => s.name);

test("anthropic-api shows only the Anthropic key field, not OpenAI/Google/CLI", () => {
  const host = { settings: { providerPreference: "anthropic-api" }, saveSettings: async () => {} };
  const panel = _el();
  renderSetupPanel(host, panel, noopCtx);
  const n = names(panel);
  assert.ok(n.includes("Anthropic API key"));
  assert.ok(!n.includes("OpenAI API key"));
  assert.ok(!n.includes("Google API key"));
  assert.ok(!n.includes("Claude Code path"));
});

test("gemini-cli shows Gemini CLI path AND Google API key", () => {
  const host = { settings: { providerPreference: "gemini-cli" }, saveSettings: async () => {} };
  const panel = _el();
  renderSetupPanel(host, panel, noopCtx);
  const n = names(panel);
  assert.ok(n.includes("Gemini CLI path"));
  assert.ok(n.includes("Google API key"));
  assert.ok(!n.includes("Anthropic API key"));
});

test("auto renders the collapsed credentials group containing ALL credential fields", () => {
  const host = { settings: { providerPreference: "auto" }, saveSettings: async () => {} };
  const panel = _el();
  renderSetupPanel(host, panel, noopCtx);
  const n = names(panel);
  for (const f of ["Anthropic API key", "OpenAI API key", "Google API key",
                   "Claude Code path", "Codex CLI path", "Gemini CLI path"]) {
    assert.ok(n.includes(f), `auto group should contain ${f}`);
  }
});

test("Setup always shows Provider; Fallback is NOT in the Setup rows", () => {
  const host = { settings: {}, saveSettings: async () => {} };
  const panel = _el();
  renderSetupPanel(host, panel, noopCtx);
  const n = names(panel);
  assert.ok(n.includes("Provider"));
  // Fallback moved to renderFallbackRows (rendered last in the Models tab).
  assert.ok(!n.includes("Fallback provider"));
});

test("renderFallbackRows shows Fallback provider; Fallback model only for an explicit provider", () => {
  const { renderFallbackRows } = require("../src/settings-view");
  // none → no Fallback-model row
  const noneHost = { settings: { fallbackProviderPreference: "none" }, saveSettings: async () => {} };
  const nonePanel = _el();
  renderFallbackRows(noneHost, nonePanel, noopCtx);
  const nn = names(nonePanel);
  assert.ok(nn.includes("Fallback provider"));
  assert.ok(!nn.includes("Fallback model"));
  // explicit provider → Fallback-model row appears
  const explicitHost = { settings: { fallbackProviderPreference: "openai-api" }, saveSettings: async () => {} };
  const explicitPanel = _el();
  renderFallbackRows(explicitHost, explicitPanel, noopCtx);
  const en = names(explicitPanel);
  assert.ok(en.includes("Fallback provider"));
  assert.ok(en.includes("Fallback model"));
});

test("all CLI path rows are on par with Claude: detection status pill + Re-detect button, no Test CLI", () => {
  const cases = [
    ["claude-code", "Claude Code path"],
    ["codex-cli", "Codex CLI path"],
    ["gemini-cli", "Gemini CLI path"],
  ];
  for (const [pref, rowName] of cases) {
    const host = { settings: { providerPreference: pref }, saveSettings: async () => {} };
    const panel = _el();
    renderSetupPanel(host, panel, noopCtx);
    const row = _allSettings(panel).find((s) => s.name === rowName);
    assert.ok(row, `${rowName} present for ${pref}`);
    // Inline detection status pill (Claude's affordance) on the name element.
    assert.ok(
      row.nameEl.__created.some((c) => c.cls === "gryphon-cli-status-pill"),
      `${rowName} renders the detection status pill`,
    );
    const buttons = row.controls.filter((c) => c.type === "button");
    assert.ok(buttons.some((b) => b.buttonText === "Re-detect"), `${rowName} has a Re-detect button`);
    assert.ok(!buttons.some((b) => b.buttonText === "Test CLI"), `${rowName} no longer shows Test CLI`);
  }
});

test("_credentialFieldsFor maps providers correctly", () => {
  const { _credentialFieldsFor } = require("../src/settings-view");
  assert.deepEqual(_credentialFieldsFor("openai-api"), ["openaiKey"]);
  assert.deepEqual(_credentialFieldsFor("gemini-cli"), ["geminiPath", "googleKey"]);
  assert.equal(_credentialFieldsFor("auto"), null);
  assert.equal(_credentialFieldsFor("something-unknown"), null);
});

test("fallback model pre-selects the kind's default, not the first (cheapest) entry", () => {
  const { _fallbackModelOptions, _defaultFallbackModel } = require("../src/settings-view");
  const pick = (kind) => _defaultFallbackModel(kind, _fallbackModelOptions(kind));
  assert.equal(pick("claude-code"), "claude-sonnet-5-5", "not Haiku");
  assert.equal(pick("codex-cli"), "gpt-5.6-terra");
  assert.equal(pick("antigravity-cli"), "gemini-3.7-flash");
  assert.equal(pick("openai-api"), "gpt-6.1-sol");
});

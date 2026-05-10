/**
 * Stage 1 (#16) factory wiring tests for openai-api + google-api.
 *
 * These exercise the routing/availability plumbing only. The actual
 * OpenAIProvider + GoogleProvider classes ship in Stage 2 (#17) and
 * Stage 3 (#18); until then both branches return null, and the
 * settings-side wiring (key persistence, detectAvailable surfacing,
 * explainUnavailable copy) is what's under test.
 *
 * When Stage 2 lands, the "openai-api preference returns null even
 * with key set" tests get inverted to assert a non-null OpenAIProvider
 * instance. Same for Stage 3 / google-api.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

// Override findClaudeBinary to return null for these tests. The dev /
// CI host may legitimately have `claude` on PATH (Gryphon developers do)
// — the factory's auto-tiebreaker correctly prefers it, but that masks
// the Stage 1 routing assertions we care about. Forcing the stub
// isolates the new branches under test from the host environment.
const utils = require("../src/utils");
const _origFindClaudeBinary = utils.findClaudeBinary;
utils.findClaudeBinary = () => null;

const factory = require("../src/factory");

// Restore the real binary lookup once the test module finishes — be a
// good citizen so other test modules running in the same node process
// see the unmocked value.
process.on("exit", () => { utils.findClaudeBinary = _origFindClaudeBinary; });

// Build a minimal plugin shim — only the shape the factory reads.
function makePlugin(settingsOverride = {}) {
  return {
    settings: {
      providerPreference: "auto",
      claudePath: "",
      anthropicApiKey: "",
      openaiApiKey: "",
      googleApiKey: "",
      ...settingsOverride,
    },
  };
}

// Each test scope clears the env-var fallback so prior tests / CI env
// can't leak into createProvider's auto-detect path.
function clearEnvKeys() {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
}

// ──────────────────────────────────────────────────────────────────────
// createProvider — explicit openai-api preference
// ──────────────────────────────────────────────────────────────────────

test("createProvider(openai-api) returns null when no key is set", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "openai-api" });
  assert.equal(factory.createProvider(plugin, "/tmp"), null);
});

test("createProvider(openai-api) returns OpenAIProvider when key is set (Stage 2 shipped)", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "openai-api", openaiApiKey: "sk-test-stub" });
  const provider = factory.createProvider(plugin, "/tmp");
  assert.notEqual(provider, null);
  assert.equal(provider.constructor.name, "OpenAIProvider");
});

test("createProvider(openai-api) reads OPENAI_API_KEY env when settings field empty", () => {
  clearEnvKeys();
  process.env.OPENAI_API_KEY = "sk-from-env";
  try {
    const plugin = makePlugin({ providerPreference: "openai-api" });
    const provider = factory.createProvider(plugin, "/tmp");
    assert.notEqual(provider, null);
    assert.equal(provider.constructor.name, "OpenAIProvider");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

// ──────────────────────────────────────────────────────────────────────
// createProvider — explicit google-api preference
// ──────────────────────────────────────────────────────────────────────

test("createProvider(google-api) returns null when no key is set", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "google-api" });
  assert.equal(factory.createProvider(plugin, "/tmp"), null);
});

test("createProvider(google-api) returns GoogleProvider when key is set (Stage 3 shipped)", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "google-api", googleApiKey: "AIza-test-stub" });
  const provider = factory.createProvider(plugin, "/tmp");
  assert.notEqual(provider, null);
  assert.equal(provider.constructor.name, "GoogleProvider");
});

test("createProvider(google-api) reads GOOGLE_API_KEY env when settings field empty", () => {
  clearEnvKeys();
  process.env.GOOGLE_API_KEY = "AIza-from-env";
  try {
    const plugin = makePlugin({ providerPreference: "google-api" });
    const provider = factory.createProvider(plugin, "/tmp");
    assert.notEqual(provider, null);
    assert.equal(provider.constructor.name, "GoogleProvider");
  } finally {
    delete process.env.GOOGLE_API_KEY;
  }
});

// ──────────────────────────────────────────────────────────────────────
// createProvider — auto preference still prefers Anthropic over new keys
// ──────────────────────────────────────────────────────────────────────

test("auto with only OpenAI key returns OpenAIProvider (Stage 2 fallthrough wired up)", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "auto", openaiApiKey: "sk-test" });
  const provider = factory.createProvider(plugin, "/tmp");
  assert.notEqual(provider, null);
  assert.equal(provider.constructor.name, "OpenAIProvider");
});

test("auto with only Google key returns GoogleProvider (Stage 3 fallthrough wired up)", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "auto", googleApiKey: "AIza-test" });
  const provider = factory.createProvider(plugin, "/tmp");
  assert.notEqual(provider, null);
  assert.equal(provider.constructor.name, "GoogleProvider");
});

test("explicit anthropic-api with key still returns AnthropicAPIProvider (no regression)", () => {
  clearEnvKeys();
  // Use the explicit preference rather than "auto" — the dev/CI host
  // may have a `claude` binary on PATH, which the auto branch would
  // (correctly) prefer first. The regression we care about for Stage 1
  // is that the existing anthropic-api branch still resolves to its
  // class; the auto-tiebreaker behavior is exercised elsewhere.
  const plugin = makePlugin({ providerPreference: "anthropic-api", anthropicApiKey: "sk-ant-test" });
  const provider = factory.createProvider(plugin, "/tmp");
  assert.notEqual(provider, null);
  assert.equal(provider.constructor.name, "AnthropicAPIProvider");
});

// ──────────────────────────────────────────────────────────────────────
// explainUnavailable — Stage 1 setup-hint copy
// ──────────────────────────────────────────────────────────────────────

test("explainUnavailable for openai-api with no key tells user to paste a key", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "openai-api" });
  const msg = factory.explainUnavailable(plugin);
  assert.match(msg, /OpenAI API key not set/);
  assert.match(msg, /Settings → Gryphon → OpenAI API key/);
});

test("explainUnavailable for openai-api with key set is the defensive fallback (Stage 2 shipped → branch is unreachable in normal flow)", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "openai-api", openaiApiKey: "sk-test" });
  const msg = factory.explainUnavailable(plugin);
  // After Stage 2 shipped, createProvider succeeds when both preference
  // and key are present, so explainUnavailable is no longer reached for
  // this case in normal flow. The branch still exists as a defensive
  // fallback (e.g. provider construction throws) — it should mention the
  // API key, not Stage 2.
  assert.match(msg, /API key|initialize/i);
});

test("explainUnavailable for google-api with no key tells user to paste a key", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "google-api" });
  const msg = factory.explainUnavailable(plugin);
  assert.match(msg, /Google API key not set/);
  assert.match(msg, /Settings → Gryphon → Google API key/);
});

test("explainUnavailable for google-api with key set is the defensive fallback (Stage 3 shipped → branch is unreachable in normal flow)", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "google-api", googleApiKey: "AIza-test" });
  const msg = factory.explainUnavailable(plugin);
  // After Stage 3 shipped, createProvider succeeds when both preference
  // and key are present, so explainUnavailable is no longer reached for
  // this case in normal flow. The branch still exists as a defensive
  // fallback (e.g. provider construction throws) — it should mention the
  // API key, not Stage 3.
  assert.match(msg, /API key|initialize/i);
});

test("explainUnavailable for anthropic-api unchanged (no regression)", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "anthropic-api" });
  const msg = factory.explainUnavailable(plugin);
  assert.match(msg, /Anthropic API key not set/);
});

// ──────────────────────────────────────────────────────────────────────
// detectAvailable — surfaces all three keys honestly
// ──────────────────────────────────────────────────────────────────────

test("detectAvailable returns null sources when no keys present", () => {
  clearEnvKeys();
  const plugin = makePlugin({});
  const out = factory.detectAvailable(plugin);
  assert.equal(out.apiKey, "");
  assert.equal(out.apiKeySource, null);
  assert.equal(out.openaiKey, "");
  assert.equal(out.openaiKeySource, null);
  assert.equal(out.googleKey, "");
  assert.equal(out.googleKeySource, null);
});

test("detectAvailable surfaces openaiKey from settings", () => {
  clearEnvKeys();
  const plugin = makePlugin({ openaiApiKey: "sk-from-settings" });
  const out = factory.detectAvailable(plugin);
  assert.equal(out.openaiKey, "sk-from-settings");
  assert.equal(out.openaiKeySource, "settings");
});

test("detectAvailable surfaces openaiKey from env when settings empty", () => {
  clearEnvKeys();
  process.env.OPENAI_API_KEY = "sk-from-env";
  try {
    const plugin = makePlugin({});
    const out = factory.detectAvailable(plugin);
    assert.equal(out.openaiKey, "sk-from-env");
    assert.equal(out.openaiKeySource, "env");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("detectAvailable surfaces googleKey from settings", () => {
  clearEnvKeys();
  const plugin = makePlugin({ googleApiKey: "AIza-from-settings" });
  const out = factory.detectAvailable(plugin);
  assert.equal(out.googleKey, "AIza-from-settings");
  assert.equal(out.googleKeySource, "settings");
});

test("detectAvailable surfaces googleKey from env when settings empty", () => {
  clearEnvKeys();
  process.env.GOOGLE_API_KEY = "AIza-from-env";
  try {
    const plugin = makePlugin({});
    const out = factory.detectAvailable(plugin);
    assert.equal(out.googleKey, "AIza-from-env");
    assert.equal(out.googleKeySource, "env");
  } finally {
    delete process.env.GOOGLE_API_KEY;
  }
});

test("detectAvailable settings beats env (precedence)", () => {
  clearEnvKeys();
  process.env.OPENAI_API_KEY = "sk-env";
  process.env.GOOGLE_API_KEY = "AIza-env";
  try {
    const plugin = makePlugin({
      openaiApiKey: "sk-settings",
      googleApiKey: "AIza-settings",
    });
    const out = factory.detectAvailable(plugin);
    assert.equal(out.openaiKey, "sk-settings");
    assert.equal(out.openaiKeySource, "settings");
    assert.equal(out.googleKey, "AIza-settings");
    assert.equal(out.googleKeySource, "settings");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  }
});

// ──────────────────────────────────────────────────────────────────────
// PROVIDER_PREFS — the dropdown source of truth
// ──────────────────────────────────────────────────────────────────────

test("PROVIDER_PREFS contains seven options spanning all SDK + CLI providers", () => {
  const { PROVIDER_PREFS } = require("../../plugin/src/constants");
  const values = PROVIDER_PREFS.map((p) => p.value).sort();
  assert.deepEqual(values, [
    "anthropic-api",
    "auto",
    "claude-code",
    "codex-cli",
    "gemini-cli",
    "google-api",
    "openai-api",
  ]);
});

test("DEFAULT_SETTINGS includes openaiApiKey and googleApiKey as empty strings", () => {
  const { DEFAULT_SETTINGS } = require("../../plugin/src/constants");
  assert.equal(DEFAULT_SETTINGS.openaiApiKey, "");
  assert.equal(DEFAULT_SETTINGS.googleApiKey, "");
});

// ──────────────────────────────────────────────────────────────────────
// Round 15 fix coverage — F20 / F21 / F22
// ──────────────────────────────────────────────────────────────────────

test("F20 fix — DEFAULT_PROVIDER_PREFERENCE is exported and equals 'auto'", () => {
  const { DEFAULT_PROVIDER_PREFERENCE } = require("@gryphon/provider-config");
  // Both createProvider and explainUnavailable consult this single
  // source of truth, so changing the default in one place updates both.
  assert.equal(DEFAULT_PROVIDER_PREFERENCE, "auto");
});

test("F20 fix — explainUnavailable with no preference behaves like 'auto', not 'anthropic-api'", () => {
  clearEnvKeys();
  // Pass a settings object that omits providerPreference entirely. Pre-fix,
  // this would have returned the Anthropic-only "key not set" message
  // (the explainUnavailable default fell back to "anthropic-api"). Post-
  // fix, both functions agree on "auto" → fall-through copy.
  const plugin = { settings: {} };
  const msg = factory.explainUnavailable(plugin);
  // The auto-fallthrough copy lists all four setup options; the
  // pre-fix Anthropic-only copy did NOT include the OpenAI / Google
  // hints.
  assert.match(msg, /OpenAI API key/);
  assert.match(msg, /Google API key/);
  assert.match(msg, /Claude Code CLI/);
});

test("F21 fix — auto with no keys lists all four setup paths, not just Anthropic", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "auto" });
  const msg = factory.explainUnavailable(plugin);
  // Pre-fix: "Paste an Anthropic API key in Settings → Gryphon → Anthropic API key."
  // Post-fix: enumerates Claude Code CLI + Anthropic + OpenAI + Google.
  assert.match(msg, /Claude Code CLI/);
  assert.match(msg, /Anthropic API key/);
  assert.match(msg, /OpenAI API key/);
  assert.match(msg, /Google API key/);
  // After Stage 3 shipped, the "adapter pending" markers are gone — all
  // four provider options are real now. Confirm the copy no longer carries
  // pending hints (would mislead users post-Stage-3).
  assert.doesNotMatch(msg, /Stage 2|Stage 3|adapter pending/i);
});

test("F22 fix successor — auto with OpenAI key now succeeds via createProvider (no explainUnavailable copy needed)", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "auto", openaiApiKey: "sk-test" });
  // Stage 2 shipped: auto with an OpenAI key returns OpenAIProvider
  // directly. The Stage 1 "F22" hint copy is no longer reached for this
  // case. We assert the new contract instead.
  const provider = factory.createProvider(plugin, "/tmp");
  assert.notEqual(provider, null);
  assert.equal(provider.constructor.name, "OpenAIProvider");
});

test("F22 fix successor — auto with Google key now succeeds via createProvider (no explainUnavailable copy needed)", () => {
  clearEnvKeys();
  const plugin = makePlugin({ providerPreference: "auto", googleApiKey: "AIza-test" });
  // Stage 3 shipped: auto with a Google key returns GoogleProvider directly.
  const provider = factory.createProvider(plugin, "/tmp");
  assert.notEqual(provider, null);
  assert.equal(provider.constructor.name, "GoogleProvider");
});

// ──────────────────────────────────────────────────────────────────────
// Bug #21 fix coverage — model toolbar shows pending hint for non-Claude
// providers (Stage 1 user-QA finding U3-followup)
// ──────────────────────────────────────────────────────────────────────

const { modelButtonText, modelButtonTitle } = require("../../plugin/src/chat-view");

test("Bug #21 — modelButtonText returns Sonnet label for anthropic-api", () => {
  const text = modelButtonText({ providerPreference: "anthropic-api", model: "sonnet" });
  assert.match(text, /Sonnet/);
});

test("Bug #21 — modelButtonText returns Sonnet label for claude-code", () => {
  const text = modelButtonText({ providerPreference: "claude-code", model: "sonnet" });
  assert.match(text, /Sonnet/);
});

test("Bug #21 — modelButtonText returns Sonnet label for auto (Anthropic-first per ADR)", () => {
  const text = modelButtonText({ providerPreference: "auto", model: "sonnet" });
  assert.match(text, /Sonnet/);
});

test("Bug #21 (Stage 2 successor) — openai-api shows OpenAI model label, not Sonnet", () => {
  // Stage 2 shipped: openai-api now reads OpenAI's model dropdown options.
  // The Sonnet label MUST NOT appear; the displayed label must come from
  // the OpenAI pricing.js dropdown options (e.g., "GPT-4o · Balanced").
  const text = modelButtonText({ providerPreference: "openai-api", model: "gpt-4o" });
  assert.doesNotMatch(text, /Sonnet/);
  assert.match(text, /GPT-4o|Balanced/i);
});

test("Bug #21 (Stage 2 successor) — openai-api with non-OpenAI model id falls back to default label", () => {
  // If a user's persisted setting is "sonnet" (e.g., they switched providers),
  // we shouldn't crash and shouldn't show "Sonnet" — we show the default
  // OpenAI label so the toolbar reflects the active provider.
  const text = modelButtonText({ providerPreference: "openai-api", model: "sonnet" });
  assert.doesNotMatch(text, /Sonnet/);
  // Must show some OpenAI-flavored label; the default is gpt-4o.
  assert.match(text, /GPT/i);
});

test("Bug #21 (Stage 3 successor) — google-api shows Gemini model label, not Sonnet/pending", () => {
  // Stage 3 shipped: google-api now reads Gemini's model dropdown options.
  const text = modelButtonText({ providerPreference: "google-api", model: "gemini-2.5-flash" });
  assert.doesNotMatch(text, /Sonnet/);
  assert.doesNotMatch(text, /pending/i);
  assert.match(text, /Gemini/i);
});

test("Bug #21 (Stage 3 successor) — google-api with non-Gemini model id falls back to default label", () => {
  const text = modelButtonText({ providerPreference: "google-api", model: "sonnet" });
  assert.doesNotMatch(text, /Sonnet/);
  assert.doesNotMatch(text, /pending/i);
  // Must show some Gemini-flavored label
  assert.match(text, /Gemini/i);
});

test("Bug #21 (Stage 2 successor) — openai-api title carries the brand label, not a pending hint", () => {
  // v1.3 Stage 5: brand-only labels — "Model (Codex)" for both
  // openai-api and codex-cli, matching the modal's "Codex" naming.
  const title = modelButtonTitle({ providerPreference: "openai-api" });
  assert.match(title, /Codex/);
  assert.doesNotMatch(title, /pending/i);
});

test("v1.3 Stage 5 — codex-cli + openai-api share the same toolbar title 'Model (Codex)'", () => {
  // The Provider dropdown still distinguishes API vs CLI internally,
  // but user-facing labels are unified to brand identity. See
  // memory/project_provider_reorg_todo.md for the rationale.
  assert.equal(modelButtonTitle({ providerPreference: "openai-api" }), "Model (Codex)");
  assert.equal(modelButtonTitle({ providerPreference: "codex-cli" }), "Model (Codex)");
});

test("v1.3 Stage 5 — gemini-cli + google-api share 'Model (Gemini)'", () => {
  assert.equal(modelButtonTitle({ providerPreference: "google-api" }), "Model (Gemini)");
  assert.equal(modelButtonTitle({ providerPreference: "gemini-cli" }), "Model (Gemini)");
});

test("v1.3 Stage 5 — anthropic-api + claude-code share 'Model (Claude)'", () => {
  assert.equal(modelButtonTitle({ providerPreference: "anthropic-api" }), "Model (Claude)");
  assert.equal(modelButtonTitle({ providerPreference: "claude-code" }), "Model (Claude)");
});

// Round 18 F23-1 regression: cross-provider switch with a non-OpenAI persisted
// model id (e.g., "sonnet" carried over from prior anthropic-api use) must produce
// agreement across THREE surfaces: (a) the toolbar label that modelButtonText
// renders, (b) the runtime model resolveModel picks for the API request, and
// (c) the labelFor output for the dropdown's selected value. Before the fix,
// these diverged: toolbar = "GPT-4o", dropdown default = "GPT-4o mini",
// runtime = "gpt-4o" — a ~17× cost surprise.
test("F23-1 — cross-provider switch: toolbar label, dropdown selection, and resolveModel agree on the same OpenAI model", () => {
  const {
    getModelDropdownOptions,
    resolveModel: resolveOpenAIModel,
  } = require("@gryphon/provider-config").pricing.openai;

  // Scenario: user previously on anthropic-api with model="sonnet", switches
  // to openai-api. Settings.model is still "sonnet" until either Settings tab
  // re-renders (which now persists a real OpenAI id) or a manual pick.
  const settings = { providerPreference: "openai-api", model: "sonnet" };

  const toolbarLabel = modelButtonText(settings);
  const runtimeModel = resolveOpenAIModel(settings.model);
  const options = getModelDropdownOptions().map((o) => ({ value: o.id, label: o.label }));
  const runtimeLabel = labelForLocal(options, runtimeModel);

  // The toolbar label must match the label of the runtime model — these are the
  // user-visible truth and the under-the-hood truth, and they must agree.
  assert.equal(toolbarLabel, runtimeLabel,
    `Toolbar shows "${toolbarLabel}" but runtime is "${runtimeModel}" (label "${runtimeLabel}"). Must agree.`);
  // Sanity: the runtime model must be in the OpenAI dropdown — otherwise the
  // user can't pick the model that's actually running.
  assert.ok(options.some((o) => o.value === runtimeModel),
    `runtime model "${runtimeModel}" must appear in the dropdown options`);
});

test("F23-1 — when persisted model is already an OpenAI id, all three surfaces still agree (negative control)", () => {
  const {
    getModelDropdownOptions,
    resolveModel: resolveOpenAIModel,
  } = require("@gryphon/provider-config").pricing.openai;

  const settings = { providerPreference: "openai-api", model: "gpt-4o-mini" };

  const toolbarLabel = modelButtonText(settings);
  const runtimeModel = resolveOpenAIModel(settings.model);
  const options = getModelDropdownOptions().map((o) => ({ value: o.id, label: o.label }));
  const runtimeLabel = labelForLocal(options, runtimeModel);

  assert.equal(runtimeModel, "gpt-4o-mini");
  assert.equal(toolbarLabel, runtimeLabel);
});

// QA-Round-Stage-3 additions: same agreement contract for cross-provider
// switches into google-api. The Gemini surface gets the same regression
// coverage as F23-1 added for OpenAI in Round 18.
test("F23-1 successor (Gemini, issue #27) — cross-vendor model id leak coerces to Gemini default; toolbar + runtime + dropdown agree", () => {
  const {
    getModelDropdownOptions,
    coerceToVendorModel: coerceGeminiModel,
  } = require("@gryphon/provider-config").pricing.google;

  // Scenario: user previously on openai-api with model="gpt-4o-mini",
  // settings.providerPreference flipped to "google-api" via a path that
  // bypassed Settings → Provider onChange (e.g., key removal in another
  // field). The runtime call MUST NOT send "gpt-4o-mini" to Gemini's API
  // (which would 400). coerceToVendorModel falls back to DEFAULT_MODEL.
  const settings = { providerPreference: "google-api", model: "gpt-4o-mini" };

  const toolbarLabel = modelButtonText(settings);
  // Use the SAME function the GoogleProvider constructor uses (coerceToVendorModel,
  // not the lenient resolveModel), because that's what determines the actual HTTP
  // model id for the request.
  const runtimeModel = coerceGeminiModel(settings.model);
  const options = getModelDropdownOptions().map((o) => ({ value: o.id, label: o.label }));
  const runtimeLabel = labelForLocal(options, runtimeModel);

  // Critical: runtime must be a known Gemini id (no cross-vendor leak).
  assert.ok(options.some((o) => o.value === runtimeModel),
    `runtime model "${runtimeModel}" must appear in the Gemini dropdown options`);
  // Toolbar must match the runtime label — what you see is what runs.
  assert.equal(toolbarLabel, runtimeLabel,
    `Toolbar shows "${toolbarLabel}" but runtime is "${runtimeModel}" (label "${runtimeLabel}"). Must agree.`);
});

test("F23-1 successor (Gemini) — anthropic alias 'sonnet' resolves to gemini-2.5-flash and surfaces consistently", () => {
  const {
    resolveModel: resolveGeminiModel,
  } = require("@gryphon/provider-config").pricing.google;

  const settings = { providerPreference: "google-api", model: "sonnet" };

  const toolbarLabel = modelButtonText(settings);
  const runtimeModel = resolveGeminiModel(settings.model);

  assert.equal(runtimeModel, "gemini-2.5-flash",
    "anthropic alias 'sonnet' must cross-vendor to gemini-2.5-flash (the new balanced default)");
  assert.match(toolbarLabel, /Gemini 2\.5 Flash/i,
    `toolbar must show the Gemini 2.5 Flash label; got "${toolbarLabel}"`);
  assert.doesNotMatch(toolbarLabel, /Sonnet/);
});

test("F23-1 successor (Gemini) — when persisted model is already a Gemini id, all surfaces agree (negative control)", () => {
  const {
    getModelDropdownOptions,
    resolveModel: resolveGeminiModel,
  } = require("@gryphon/provider-config").pricing.google;

  const settings = { providerPreference: "google-api", model: "gemini-2.5-pro" };

  const toolbarLabel = modelButtonText(settings);
  const runtimeModel = resolveGeminiModel(settings.model);
  const options = getModelDropdownOptions().map((o) => ({ value: o.id, label: o.label }));
  const runtimeLabel = labelForLocal(options, runtimeModel);

  assert.equal(runtimeModel, "gemini-2.5-pro");
  assert.equal(toolbarLabel, runtimeLabel);
});

// Lightweight local labelFor — mirrors the helper used inside modelButtonText.
// Defined locally so the test doesn't need to import a non-exported helper.
function labelForLocal(list, value) {
  const item = list.find((x) => x.value === value);
  return item ? item.label : value;
}

test("Bug #21 (Stage 3 successor) — google-api title is 'Model (Gemini)', not pending hint", () => {
  const title = modelButtonTitle({ providerPreference: "google-api" });
  assert.match(title, /Gemini/);
  assert.doesNotMatch(title, /pending/i);
});

test("Bug #21 — modelButtonTitle returns brand label for Anthropic modes; plain 'Model' for unknown/auto", () => {
  // v1.3 Stage 5: anthropic-api + claude-code now share "Model (Claude)"
  // matching the modal's brand-only naming. "auto" stays plain "Model"
  // until the active provider resolves (it's the user's catch-all).
  assert.equal(modelButtonTitle({ providerPreference: "anthropic-api" }), "Model (Claude)");
  assert.equal(modelButtonTitle({ providerPreference: "claude-code" }), "Model (Claude)");
  assert.equal(modelButtonTitle({ providerPreference: "auto" }), "Model");
});

test("F22 fix — auto with both OpenAI AND Anthropic keys set: Anthropic wins (no F22 hint), provider available", () => {
  clearEnvKeys();
  const plugin = makePlugin({
    providerPreference: "auto",
    anthropicApiKey: "sk-ant-test",
    openaiApiKey: "sk-openai-test",
  });
  // createProvider succeeds on the Anthropic path — the F22 hint
  // never fires because the user has a working provider. The
  // "OpenAI adapter pending" copy would be wrong here.
  const provider = factory.createProvider(plugin, "/tmp");
  assert.notEqual(provider, null);
  assert.equal(provider.constructor.name, "AnthropicAPIProvider");
});

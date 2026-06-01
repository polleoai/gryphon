const { test } = require("node:test");
const assert = require("node:assert/strict");
const openai = require("../src/pricing/openai");

test("MODEL_PRICES keys still include the gpt-5 family", () => {
  assert.equal(openai.MODEL_PRICES["gpt-5.5"].input, 5.00);
  assert.equal(openai.MODEL_PRICES["gpt-5.4-mini"].output, 4.50);
  assert.ok(openai.MODEL_PRICES._default, "must keep _default fallback");
});

test("MODEL_ALIAS cross-vendor mappings preserved", () => {
  assert.equal(openai.MODEL_ALIAS["opus"], "gpt-5.4");
  assert.equal(openai.MODEL_ALIAS["sonnet"], "gpt-5.4-mini");
  assert.equal(openai.MODEL_ALIAS["haiku"], "gpt-5-mini");
});

test("MODEL_ALIAS native passthrough preserved", () => {
  assert.equal(openai.MODEL_ALIAS["gpt-5.5"], "gpt-5.5");
  assert.equal(openai.MODEL_ALIAS["gpt-4o"], "gpt-4o");
  assert.equal(openai.MODEL_ALIAS["o3"], "o3");
});

test("DEFAULT_MODEL is gpt-5.4-mini", () => {
  assert.equal(openai.DEFAULT_MODEL, "gpt-5.4-mini");
});

test("CODEX_CLI_SUPPORTED_MODELS subset matches prior surface", () => {
  assert.ok(openai.CODEX_CLI_SUPPORTED_MODELS.has("gpt-5.5"));
  assert.ok(openai.CODEX_CLI_SUPPORTED_MODELS.has("gpt-5.4"));
  assert.ok(openai.CODEX_CLI_SUPPORTED_MODELS.has("gpt-5.4-mini"));
  assert.equal(openai.CODEX_CLI_SUPPORTED_MODELS.has("gpt-5"), false);
  assert.equal(openai.CODEX_CLI_SUPPORTED_MODELS.has("gpt-4o"), false);
});

test("getModelDropdownOptions returns OpenAI entries with id+label", () => {
  const opts = openai.getModelDropdownOptions();
  assert.ok(opts.length > 0);
  assert.ok(opts.some((o) => o.id === "gpt-5.5"));
  for (const o of opts) {
    assert.equal(typeof o.id, "string");
    assert.equal(typeof o.label, "string");
  }
});

test("getCodexCliModelDropdownOptions is subset of full dropdown", () => {
  const codexOpts = openai.getCodexCliModelDropdownOptions();
  for (const o of codexOpts) {
    assert.ok(openai.CODEX_CLI_SUPPORTED_MODELS.has(o.id), `${o.id} should be in CODEX_CLI subset`);
  }
});

test("coerceToVendorModel falls back to default on cross-vendor leak", () => {
  assert.equal(openai.coerceToVendorModel("claude-sonnet-4-6"), openai.DEFAULT_MODEL);
});

test("coerceToVendorModel passes through gpt-/o3-/o4- prefixed unknown ids (forward-compat)", () => {
  assert.equal(openai.coerceToVendorModel("gpt-future-9"), "gpt-future-9");
  // o5-mini does NOT match /^(gpt-|o3|o4)/i — falls back to DEFAULT_MODEL
  assert.equal(openai.coerceToVendorModel("o4-future"), "o4-future");
  assert.equal(openai.coerceToVendorModel("o3-future"), "o3-future");
});

test("coerceToCodexCliModel restricts to ChatGPT-auth subset", () => {
  assert.equal(openai.coerceToCodexCliModel("gpt-5.5"), "gpt-5.5");
  assert.equal(openai.coerceToCodexCliModel("gpt-4o"), openai.CODEX_CLI_DEFAULT_MODEL);
});

test("computeCost handles OpenAI usage shape", () => {
  const r = openai.computeCost({ prompt_tokens: 1_000_000, completion_tokens: 100_000 }, "gpt-5.4-mini");
  assert.ok(r.cost > 0, "should return non-zero cost");
  assert.equal(r.breakdown.input + r.breakdown.output, r.cost);
  assert.equal(r.breakdown.cachedTokens, 0);
});

test("computeCost includes cachedTokens from prompt_tokens_details", () => {
  const r = openai.computeCost(
    { prompt_tokens: 100_000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 30_000 } },
    "gpt-5.4-mini",
  );
  assert.equal(r.breakdown.cachedTokens, 30_000);
});

// Fix 3: MODEL_ALIAS IIFE collision guard
test("MODEL_ALIAS IIFE loads without collision (module-load regression guard) (Fix 3)", () => {
  assert.ok(openai.MODEL_ALIAS, "module loaded without throwing alias collision");
});

// Fix 4: NaN token count handling
test("computeCost handles NaN prompt_tokens safely (Fix 4)", () => {
  // gpt-5.4-mini: output $4.50/M; 100 tokens = $0.00045
  const r = openai.computeCost(
    { prompt_tokens: NaN, completion_tokens: 100 },
    "gpt-5.4-mini",
  );
  assert.ok(Number.isFinite(r.cost), `cost should be finite, got ${r.cost}`);
  assert.ok(r.cost > 0, "NaN prompt_tokens should not zero-out output cost");
});

test("computeCost handles NaN completion_tokens safely (Fix 4)", () => {
  const r = openai.computeCost(
    { prompt_tokens: 1_000_000, completion_tokens: NaN },
    "gpt-5.4-mini",
  );
  assert.ok(Number.isFinite(r.cost), `cost should be finite, got ${r.cost}`);
  assert.ok(r.cost > 0, "NaN completion_tokens should not zero-out input cost");
});

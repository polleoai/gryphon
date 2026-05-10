/**
 * Stage 2 (#17) OpenAI pricing + cost-calculation tests.
 *
 * Validates: model alias resolution, fallback to _default for unknown
 * models, USD cost math against published OpenAI rates, and the v1.2
 * design decision that cached tokens are tracked separately but BILLED
 * at full input rate (i.e. computeCost ignores the cached-input column).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

const {
  MODEL_PRICES,
  MODEL_ALIAS,
  DEFAULT_MODEL,
  resolveModel,
  priceFor,
  computeCost,
  getModelDropdownOptions,
} = require("../src/pricing/openai");

// ---------- alias resolution ----------

test("resolveModel returns DEFAULT_MODEL for null/undefined/empty input", () => {
  assert.equal(resolveModel(null), DEFAULT_MODEL);
  assert.equal(resolveModel(undefined), DEFAULT_MODEL);
  assert.equal(resolveModel(""), DEFAULT_MODEL);
});

test("resolveModel maps Anthropic-style aliases (haiku/sonnet/opus) to GPT-5-tier equivalents", () => {
  // Updated 2026-05-02: aliases re-pointed from gpt-4o family to gpt-5
  // family when the gpt-5 line became GA. Switching providers should land
  // a user on the current-tier OpenAI model, not a 4o-era one.
  assert.equal(resolveModel("haiku"), "gpt-5-mini");
  assert.equal(resolveModel("sonnet"), "gpt-5.4-mini");
  assert.equal(resolveModel("opus"), "gpt-5.4");
  assert.equal(resolveModel("opus[1m]"), "gpt-5.4");
});

test("resolveModel passes OpenAI native model IDs through unchanged", () => {
  const ids = [
    "gpt-5", "gpt-5-mini", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5",
    "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini",
    "o3", "o3-mini", "o4-mini",
  ];
  for (const id of ids) assert.equal(resolveModel(id), id);
});

test("resolveModel passes unknown IDs through (priceFor handles fallback)", () => {
  assert.equal(resolveModel("gpt-99-imaginary"), "gpt-99-imaginary");
});

// ---------- price lookup + fallback ----------

test("priceFor returns the model's price object for known models", () => {
  assert.deepEqual(priceFor("gpt-4o"), { input: 2.50, output: 10.00, cached_input: 1.25 });
  assert.deepEqual(priceFor("gpt-4o-mini"), { input: 0.15, output: 0.60, cached_input: 0.075 });
});

test("priceFor returns _default for unknown models", () => {
  assert.deepEqual(priceFor("gpt-nope"), MODEL_PRICES._default);
});

test("MODEL_PRICES has _default fallback row", () => {
  assert.ok(MODEL_PRICES._default, "_default must exist");
  assert.equal(typeof MODEL_PRICES._default.input, "number");
  assert.equal(typeof MODEL_PRICES._default.output, "number");
  assert.equal(typeof MODEL_PRICES._default.cached_input, "number");
});

test("every MODEL_PRICES entry has all three fields", () => {
  for (const [id, p] of Object.entries(MODEL_PRICES)) {
    assert.equal(typeof p.input, "number", `${id}: input must be number`);
    assert.equal(typeof p.output, "number", `${id}: output must be number`);
    assert.equal(typeof p.cached_input, "number", `${id}: cached_input must be number`);
    assert.ok(p.input >= 0, `${id}: input must be non-negative`);
    assert.ok(p.output >= 0, `${id}: output must be non-negative`);
    assert.ok(p.cached_input >= 0, `${id}: cached_input must be non-negative`);
  }
});

// ---------- cost math ----------

test("computeCost returns 0 for null/undefined usage", () => {
  assert.equal(computeCost(null, "gpt-4o").cost, 0);
  assert.equal(computeCost(undefined, "gpt-4o").cost, 0);
});

test("computeCost: gpt-4o, 1M input + 1M output = $12.50", () => {
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  const { cost } = computeCost(usage, "gpt-4o");
  // 1M × 2.50 + 1M × 10.00 = 12.50
  assert.equal(cost.toFixed(2), "12.50");
});

test("computeCost: gpt-4o-mini, 100K input + 50K output", () => {
  const usage = { prompt_tokens: 100_000, completion_tokens: 50_000 };
  const { cost } = computeCost(usage, "gpt-4o-mini");
  // 100K × 0.15/M + 50K × 0.60/M = 0.015 + 0.030 = 0.045
  assert.equal(cost.toFixed(4), "0.0450");
});

test("computeCost: cached tokens are billed at FULL input rate (v1.2 decision)", () => {
  const noCache = computeCost(
    { prompt_tokens: 1_000_000, completion_tokens: 0 },
    "gpt-4o",
  );
  const withCache = computeCost(
    {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 500_000 },
    },
    "gpt-4o",
  );
  // Per the design-spec decision, cached tokens are billed at full rate;
  // the only difference is breakdown.cachedTokens reports the count.
  assert.equal(withCache.cost, noCache.cost, "cost must be identical regardless of cached_tokens");
  assert.equal(withCache.breakdown.cachedTokens, 500_000);
  assert.equal(noCache.breakdown.cachedTokens, 0);
});

test("computeCost: breakdown reports input + output costs separately", () => {
  const { cost, breakdown } = computeCost(
    { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    "gpt-4o",
  );
  assert.equal(breakdown.input, 2.50);
  assert.equal(breakdown.output, 10.00);
  assert.equal(cost, breakdown.input + breakdown.output);
});

test("computeCost: unknown model falls back to _default pricing (mirrors gpt-5.4-mini)", () => {
  const { cost: known } = computeCost(
    { prompt_tokens: 1_000_000, completion_tokens: 0 },
    "gpt-5.4-mini",
  );
  const { cost: unknown } = computeCost(
    { prompt_tokens: 1_000_000, completion_tokens: 0 },
    "gpt-mystery",
  );
  // _default mirrors gpt-5.4-mini pricing (the new general-purpose mid-tier)
  assert.equal(known, unknown);
});

test("computeCost: missing prompt_tokens or completion_tokens treated as 0", () => {
  assert.equal(computeCost({}, "gpt-4o").cost, 0);
  assert.equal(
    computeCost({ prompt_tokens: 1_000_000 }, "gpt-4o").cost,
    2.50,
  );
  assert.equal(
    computeCost({ completion_tokens: 1_000_000 }, "gpt-4o").cost,
    10.00,
  );
});

test("computeCost: cached_tokens missing from prompt_tokens_details is fine", () => {
  const { breakdown } = computeCost(
    { prompt_tokens: 100, completion_tokens: 100, prompt_tokens_details: {} },
    "gpt-4o",
  );
  assert.equal(breakdown.cachedTokens, 0);
});

// ---------- model dropdown ----------

test("getModelDropdownOptions returns array of {id, label}", () => {
  const opts = getModelDropdownOptions();
  assert.ok(Array.isArray(opts));
  assert.ok(opts.length >= 5, "should include at least 5 production-grade models");
  for (const o of opts) {
    assert.equal(typeof o.id, "string");
    assert.equal(typeof o.label, "string");
    assert.ok(o.id.length > 0);
    assert.ok(o.label.length > 0);
  }
});

test("every dropdown option has a corresponding price row", () => {
  for (const { id } of getModelDropdownOptions()) {
    assert.ok(MODEL_PRICES[id], `dropdown id "${id}" must exist in MODEL_PRICES`);
  }
});

// ---------- restore module resolver ----------

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});

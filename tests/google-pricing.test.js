/**
 * Stage 3 (#18) Google/Gemini pricing + cost-calculation tests.
 *
 * Mirrors the OpenAI pricing test file so any cross-provider regressions
 * (e.g. dropdown integrity, _default fallback shape) surface symmetrically.
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
} = require("../src/providers/google-api/pricing");

// ---------- alias resolution ----------

test("resolveModel returns DEFAULT_MODEL (gemini-2.5-flash) for null/undefined/empty", () => {
  assert.equal(resolveModel(null), DEFAULT_MODEL);
  assert.equal(resolveModel(undefined), DEFAULT_MODEL);
  assert.equal(resolveModel(""), DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, "gemini-2.5-flash");
});

test("resolveModel maps Anthropic-style aliases (haiku/sonnet/opus) to Gemini counterparts", () => {
  assert.equal(resolveModel("haiku"), "gemini-2.5-flash-lite");
  assert.equal(resolveModel("sonnet"), "gemini-2.5-flash");
  assert.equal(resolveModel("opus"), "gemini-2.5-pro");
  assert.equal(resolveModel("opus[1m]"), "gemini-2.5-pro");
});

test("resolveModel passes Gemini native ids through unchanged", () => {
  for (const id of [
    "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
    "gemini-3.1-pro-preview", "gemini-3-flash-preview",
  ]) {
    assert.equal(resolveModel(id), id);
  }
});

test("resolveModel passes unknown ids through (priceFor handles fallback)", () => {
  assert.equal(resolveModel("gemini-99-imaginary"), "gemini-99-imaginary");
});

// ---------- price lookup + fallback ----------

test("priceFor returns the model's price for known models", () => {
  assert.deepEqual(priceFor("gemini-2.5-pro"), { input: 1.25, output: 10.00, cached_input: 0.125 });
  assert.deepEqual(priceFor("gemini-2.5-flash"), { input: 0.30, output: 2.50, cached_input: 0.03 });
});

test("priceFor returns _default for unknown models", () => {
  assert.deepEqual(priceFor("gemini-mystery"), MODEL_PRICES._default);
});

test("MODEL_PRICES has _default fallback row with all three fields", () => {
  assert.ok(MODEL_PRICES._default);
  assert.equal(typeof MODEL_PRICES._default.input, "number");
  assert.equal(typeof MODEL_PRICES._default.output, "number");
  assert.equal(typeof MODEL_PRICES._default.cached_input, "number");
});

test("every MODEL_PRICES entry has all three numeric, non-negative fields", () => {
  for (const [id, p] of Object.entries(MODEL_PRICES)) {
    assert.equal(typeof p.input, "number", `${id}: input`);
    assert.equal(typeof p.output, "number", `${id}: output`);
    assert.equal(typeof p.cached_input, "number", `${id}: cached_input`);
    assert.ok(p.input >= 0 && p.output >= 0 && p.cached_input >= 0, `${id}: must be non-negative`);
  }
});

// ---------- cost math ----------

test("computeCost returns 0 for null/undefined usage", () => {
  assert.equal(computeCost(null, "gemini-2.5-flash").cost, 0);
  assert.equal(computeCost(undefined, "gemini-2.5-flash").cost, 0);
});

test("computeCost: gemini-2.5-pro, 1M input + 1M output = $11.25", () => {
  const usage = { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 };
  const { cost } = computeCost(usage, "gemini-2.5-pro");
  // 1M × 1.25 + 1M × 10.00 = 11.25
  assert.equal(cost.toFixed(2), "11.25");
});

test("computeCost: gemini-2.5-flash, 100K input + 50K output", () => {
  const usage = { promptTokenCount: 100_000, candidatesTokenCount: 50_000 };
  const { cost } = computeCost(usage, "gemini-2.5-flash");
  // 100K × 0.30/M + 50K × 2.50/M = 0.030 + 0.125 = 0.155
  assert.equal(cost.toFixed(4), "0.1550");
});

test("computeCost: cached tokens billed at full input rate (v1.2 decision)", () => {
  const noCache = computeCost(
    { promptTokenCount: 1_000_000, candidatesTokenCount: 0 },
    "gemini-2.5-pro",
  );
  const withCache = computeCost(
    {
      promptTokenCount: 1_000_000,
      candidatesTokenCount: 0,
      cachedContentTokenCount: 500_000,
    },
    "gemini-2.5-pro",
  );
  assert.equal(withCache.cost, noCache.cost);
  assert.equal(withCache.breakdown.cachedTokens, 500_000);
  assert.equal(noCache.breakdown.cachedTokens, 0);
});

test("computeCost: breakdown reports input + output costs separately", () => {
  const { cost, breakdown } = computeCost(
    { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 },
    "gemini-2.5-pro",
  );
  assert.equal(breakdown.input, 1.25);
  assert.equal(breakdown.output, 10.00);
  assert.equal(cost, breakdown.input + breakdown.output);
});

test("computeCost: unknown model falls back to _default pricing (mirrors gemini-2.5-flash)", () => {
  const { cost: known } = computeCost(
    { promptTokenCount: 1_000_000, candidatesTokenCount: 0 },
    "gemini-2.5-flash",
  );
  const { cost: unknown } = computeCost(
    { promptTokenCount: 1_000_000, candidatesTokenCount: 0 },
    "gemini-mystery",
  );
  assert.equal(known, unknown);
});

test("computeCost: missing prompt/candidates token counts treated as 0", () => {
  assert.equal(computeCost({}, "gemini-2.5-pro").cost, 0);
  assert.equal(
    computeCost({ promptTokenCount: 1_000_000 }, "gemini-2.5-pro").cost,
    1.25,
  );
  assert.equal(
    computeCost({ candidatesTokenCount: 1_000_000 }, "gemini-2.5-pro").cost,
    10.00,
  );
});

// ---------- model dropdown ----------

test("getModelDropdownOptions returns array of {id, label}", () => {
  const opts = getModelDropdownOptions();
  assert.ok(Array.isArray(opts));
  assert.ok(opts.length >= 3);
  for (const o of opts) {
    assert.equal(typeof o.id, "string");
    assert.equal(typeof o.label, "string");
    assert.ok(o.id.length > 0 && o.label.length > 0);
  }
});

test("every dropdown option has a corresponding price row", () => {
  for (const { id } of getModelDropdownOptions()) {
    assert.ok(MODEL_PRICES[id], `dropdown id "${id}" must exist in MODEL_PRICES`);
  }
});

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});

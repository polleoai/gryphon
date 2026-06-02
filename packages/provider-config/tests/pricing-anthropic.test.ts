/**
 * Tests for packages/provider-config/src/pricing/anthropic.js
 *
 * Validates: MODEL_PRICES shape derived from registry, MODEL_ALIAS
 * cross-vendor + identity-passthrough coverage, resolveModel fallback,
 * priceFor lookup + _default fallback, and computeCost numeric return
 * with cache-write (1.25×) and cache-read (0.1×) multipliers.
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

const anthropic = require("../src/pricing/anthropic");

// ---------- MODEL_PRICES ----------

test("pricing/anthropic re-exports MODEL_PRICES derived from registry", () => {
  assert.equal(anthropic.MODEL_PRICES["claude-sonnet-4-6"].input, 3.00);
  assert.equal(anthropic.MODEL_PRICES["claude-opus-4-8"].output, 25.00);
  assert.ok(anthropic.MODEL_PRICES._default, "must keep _default fallback");
  assert.equal(anthropic.MODEL_PRICES._default.input, 3.00, "Sonnet pricing for unknown ids");
});

test("MODEL_PRICES includes all known Anthropic model IDs", () => {
  const expectedIds = [
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
  ];
  for (const id of expectedIds) {
    assert.ok(anthropic.MODEL_PRICES[id], `MODEL_PRICES missing entry for ${id}`);
  }
});

// ---------- MODEL_ALIAS ----------

test("MODEL_ALIAS maps cross-vendor aliases to current Anthropic flagships", () => {
  assert.equal(anthropic.MODEL_ALIAS["opus"], "claude-opus-4-8");
  assert.equal(anthropic.MODEL_ALIAS["opus[1m]"], "claude-opus-4-8");
  assert.equal(anthropic.MODEL_ALIAS["sonnet"], "claude-sonnet-4-6");
  assert.equal(anthropic.MODEL_ALIAS["haiku"], "claude-haiku-4-5");
});

test("MODEL_ALIAS passes through native concrete ids", () => {
  assert.equal(anthropic.MODEL_ALIAS["claude-sonnet-4-6"], "claude-sonnet-4-6");
  assert.equal(anthropic.MODEL_ALIAS["claude-opus-4-8"], "claude-opus-4-8");
  assert.equal(anthropic.MODEL_ALIAS["claude-haiku-4-5"], "claude-haiku-4-5");
});

// ---------- DEFAULT_MODEL ----------

test("DEFAULT_MODEL is claude-sonnet-4-6", () => {
  assert.equal(anthropic.DEFAULT_MODEL, "claude-sonnet-4-6");
});

// ---------- resolveModel ----------

test("resolveModel returns concrete id for alias", () => {
  assert.equal(anthropic.resolveModel("opus"), "claude-opus-4-8");
  assert.equal(anthropic.resolveModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(anthropic.resolveModel(undefined), "claude-sonnet-4-6", "default fallback");
  assert.equal(anthropic.resolveModel(null), "claude-sonnet-4-6", "null also defaults");
});

test("resolveModel passes unknown ids through (priceFor handles fallback)", () => {
  assert.equal(anthropic.resolveModel("claude-future-9-9"), "claude-future-9-9");
});

// ---------- priceFor ----------

test("priceFor known id returns its pricing", () => {
  assert.deepEqual(anthropic.priceFor("claude-opus-4-8"), { input: 5.00, output: 25.00 });
});

test("priceFor unknown id returns _default", () => {
  assert.deepEqual(anthropic.priceFor("claude-future-9-9"), anthropic.MODEL_PRICES._default);
});

// ---------- computeCost — returns a number ----------

test("computeCost returns 0 for null/undefined usage", () => {
  assert.equal(anthropic.computeCost(null, "claude-sonnet-4-6"), 0);
  assert.equal(anthropic.computeCost(undefined, "claude-sonnet-4-6"), 0);
});

test("computeCost handles Anthropic usage shape (input_tokens / output_tokens)", () => {
  // claude-sonnet-4-6: input $3/M, output $15/M
  // 1M input @ $3 + 100K output @ $1.50 = $4.50
  const r = anthropic.computeCost(
    { input_tokens: 1_000_000, output_tokens: 100_000 },
    "claude-sonnet-4-6",
  );
  assert.equal(typeof r, "number", "computeCost must return a number");
  assert.ok(Math.abs(r - 4.50) < 0.0001, `expected ~4.50, got ${r}`);
});

test("computeCost applies cache-write 1.25x and cache-read 0.1x", () => {
  // claude-sonnet-4-6: input $3/M, output $15/M
  // cache_creation: 100K × 1.25 = 125K effective input tokens
  // cache_read:     200K × 0.1  =  20K effective input tokens
  // regular input:  100K
  // total effective input: 245K → 245K/1M × $3 = $0.735
  // output: 50K → 50K/1M × $15 = $0.75
  // total: $1.485
  const r = anthropic.computeCost(
    {
      input_tokens: 100_000,
      cache_creation_input_tokens: 100_000,
      cache_read_input_tokens: 200_000,
      output_tokens: 50_000,
    },
    "claude-sonnet-4-6",
  );
  assert.equal(typeof r, "number", "computeCost must return a number");
  assert.ok(Math.abs(r - 1.485) < 0.0001, `expected ~1.485, got ${r}`);
});

test("computeCost falls back to _default for unknown model", () => {
  // Unknown model uses _default { input: 3.00, output: 15.00 } (Sonnet rates)
  const r = anthropic.computeCost(
    { input_tokens: 1_000_000, output_tokens: 0 },
    "claude-future-9-9",
  );
  assert.ok(Math.abs(r - 3.00) < 0.0001, `expected ~3.00, got ${r}`);
});

// Fix 3: MODEL_ALIAS IIFE loaded without collision
test("MODEL_ALIAS IIFE loads without collision (module-load regression guard) (Fix 3)", () => {
  // The IIFE runs at module load; if a collision was detected, require() would throw.
  // Getting here proves no collision.
  assert.ok(anthropic.MODEL_ALIAS, "module loaded without throwing alias collision");
});

// Fix 4: NaN token count handling
test("computeCost handles NaN input_tokens safely (Fix 4)", () => {
  // claude-sonnet-4-6: output $15/M; 100 output tokens = $0.0015
  const r = anthropic.computeCost(
    { input_tokens: NaN, output_tokens: 100 },
    "claude-sonnet-4-6",
  );
  assert.ok(Number.isFinite(r), `cost should be finite, got ${r}`);
  assert.ok(r > 0, "non-finite input_tokens should not zero-out the output cost");
});

test("computeCost handles NaN output_tokens safely (Fix 4)", () => {
  // 1M input at $3/M = $3.00
  const r = anthropic.computeCost(
    { input_tokens: 1_000_000, output_tokens: NaN },
    "claude-sonnet-4-6",
  );
  assert.ok(Number.isFinite(r), `cost should be finite, got ${r}`);
  assert.ok(r > 0, "non-finite output_tokens should not zero-out input cost");
});

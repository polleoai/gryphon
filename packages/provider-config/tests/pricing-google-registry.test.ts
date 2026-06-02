const { test } = require("node:test");
const assert = require("node:assert/strict");
const google = require("../src/pricing/google");

test("MODEL_PRICES preserved across v2.2 refactor", () => {
  assert.equal(google.MODEL_PRICES["gemini-2.5-flash"].input, 0.30);
  assert.equal(google.MODEL_PRICES["gemini-2.5-pro"].output, 10.00);
  assert.ok(google.MODEL_PRICES._default);
});

test("MODEL_ALIAS cross-vendor mappings preserved", () => {
  assert.equal(google.MODEL_ALIAS["opus"], "gemini-2.5-pro");
  assert.equal(google.MODEL_ALIAS["sonnet"], "gemini-2.5-flash");
  assert.equal(google.MODEL_ALIAS["haiku"], "gemini-2.5-flash-lite");
});

test("MODEL_ALIAS native passthrough preserved", () => {
  assert.equal(google.MODEL_ALIAS["gemini-2.5-flash"], "gemini-2.5-flash");
  assert.equal(google.MODEL_ALIAS["gemini-3.1-pro-preview"], "gemini-3.1-pro-preview");
});

test("DEFAULT_MODEL is gemini-2.5-flash", () => {
  assert.equal(google.DEFAULT_MODEL, "gemini-2.5-flash");
});

test("getModelDropdownOptions has gemini-2.5-flash labelled default", () => {
  const opts = google.getModelDropdownOptions();
  const flash = opts.find((o) => o.id === "gemini-2.5-flash");
  assert.ok(flash);
  assert.match(flash.label, /default/i);
});

test("coerceToVendorModel falls back to default on cross-vendor leak", () => {
  assert.equal(google.coerceToVendorModel("gpt-4o-mini"), google.DEFAULT_MODEL);
});

test("coerceToVendorModel passes through gemini- prefixed unknown ids (forward-compat)", () => {
  assert.equal(google.coerceToVendorModel("gemini-future-9"), "gemini-future-9");
});

test("computeCost handles Google usage shape", () => {
  const r = google.computeCost({ promptTokenCount: 1_000_000, candidatesTokenCount: 100_000 }, "gemini-2.5-flash");
  assert.ok(r.cost > 0);
  assert.equal(r.breakdown.input + r.breakdown.output, r.cost);
});

test("computeCost includes cachedContentTokenCount in breakdown", () => {
  const r = google.computeCost(
    { promptTokenCount: 100_000, candidatesTokenCount: 1000, cachedContentTokenCount: 30_000 },
    "gemini-2.5-flash",
  );
  assert.equal(r.breakdown.cachedTokens, 30_000);
  // Cached tokens still billed at full input rate per v1.2 design (consistent
  // with anthropic-api + openai-api).
  assert.ok(r.cost > 0);
});

// Fix 3: MODEL_ALIAS IIFE collision guard
test("MODEL_ALIAS IIFE loads without collision (module-load regression guard) (Fix 3)", () => {
  assert.ok(google.MODEL_ALIAS, "module loaded without throwing alias collision");
});

// Fix 4: NaN token count handling
test("computeCost handles NaN promptTokenCount safely (Fix 4)", () => {
  // gemini-2.5-flash: output $2.50/M; 100 tokens = $0.00025
  const r = google.computeCost(
    { promptTokenCount: NaN, candidatesTokenCount: 100 },
    "gemini-2.5-flash",
  );
  assert.ok(Number.isFinite(r.cost), `cost should be finite, got ${r.cost}`);
  assert.ok(r.cost > 0, "NaN promptTokenCount should not zero-out output cost");
});

test("computeCost handles NaN candidatesTokenCount safely (Fix 4)", () => {
  const r = google.computeCost(
    { promptTokenCount: 1_000_000, candidatesTokenCount: NaN },
    "gemini-2.5-flash",
  );
  assert.ok(Number.isFinite(r.cost), `cost should be finite, got ${r.cost}`);
  assert.ok(r.cost > 0, "NaN candidatesTokenCount should not zero-out input cost");
});

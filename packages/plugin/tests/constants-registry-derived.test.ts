const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  MODELS,
  MODEL_CONTEXT,
  COLD_START_BUDGET_MS,
  MODEL_ALIAS_MIGRATION,
} = require("../src/constants");

test("MODELS dropdown is exactly the current Anthropic lineup", () => {
  const ids = MODELS.map((m) => m.value);
  assert.deepEqual(
    ids.slice().sort(),
    ["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5-5"],
  );
});

test("MODELS entries have value, label, desc fields", () => {
  for (const m of MODELS) {
    assert.equal(typeof m.value, "string");
    assert.equal(typeof m.label, "string");
    assert.equal(typeof m.desc, "string");
  }
});

test("MODEL_CONTEXT marks Sonnet 4.6 as 1M and Haiku 4.5 as 200K", () => {
  assert.equal(MODEL_CONTEXT["claude-sonnet-4-6"], 1_000_000);
  assert.equal(MODEL_CONTEXT["claude-haiku-4-5"], 200_000);
  assert.equal(MODEL_CONTEXT["claude-opus-4-8"], 1_000_000);
});

test("COLD_START_BUDGET_MS marks Opus models as 180s, Sonnet as 90s, Haiku as 30s", () => {
  assert.equal(COLD_START_BUDGET_MS["claude-haiku-4-5"], 30_000);
  assert.equal(COLD_START_BUDGET_MS["claude-sonnet-4-6"], 90_000);
  assert.equal(COLD_START_BUDGET_MS["claude-opus-4-6"], 180_000);
  assert.equal(COLD_START_BUDGET_MS["claude-opus-4-7"], 180_000);
  assert.equal(COLD_START_BUDGET_MS["claude-opus-4-8"], 180_000);
});

test("MODEL_ALIAS_MIGRATION points old aliases to current Anthropic flagships", () => {
  assert.equal(MODEL_ALIAS_MIGRATION["haiku"], "claude-haiku-4-5");
  assert.equal(MODEL_ALIAS_MIGRATION["sonnet"], "claude-sonnet-5-5");
  assert.equal(MODEL_ALIAS_MIGRATION["opus"], "claude-opus-5-5");
  assert.equal(MODEL_ALIAS_MIGRATION["opus[1m]"], "claude-opus-5-5");
});

test("MODEL_ALIAS_MIGRATION keys are exactly the four legacy aliases", () => {
  assert.deepEqual(
    Object.keys(MODEL_ALIAS_MIGRATION).sort(),
    ["haiku", "opus", "opus[1m]", "sonnet"].sort(),
  );
});

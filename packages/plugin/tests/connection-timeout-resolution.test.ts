/**
 * Issue #38 — model-adaptive connection-timeout resolver.
 *
 * Pure-function unit tests for `resolveConnectionTimeoutMs`. The
 * function takes the user's `connectionTimeoutMs` setting (the
 * override) plus the active `model` identifier, and returns the
 * timeout budget in milliseconds.
 *
 * Behavior under test:
 *   1. A finite, in-range override wins.
 *   2. Anything else (null / undefined / NaN / non-number / out of
 *      bounds / negative / zero) falls through to the model-adaptive
 *      default from COLD_START_BUDGET_MS, with a final fallback to
 *      DEFAULT_COLD_START_BUDGET_MS for unknown models.
 *
 * Why the bounds-rejection cases matter: a user accidentally entering
 * "1" (1 ms — the timer fires immediately) or "1000000" (16 minutes —
 * a hung process becomes indistinguishable from a slow one) silently
 * reverts to the model-adaptive default rather than being honored.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveConnectionTimeoutMs,
  COLD_START_BUDGET_MS,
  DEFAULT_COLD_START_BUDGET_MS,
  MIN_COLD_START_BUDGET_MS,
  MAX_COLD_START_BUDGET_MS,
} = require("../src/constants");

test("model-adaptive default applies when override is null", () => {
  for (const model of Object.keys(COLD_START_BUDGET_MS)) {
    assert.equal(
      resolveConnectionTimeoutMs({ override: null, model }),
      COLD_START_BUDGET_MS[model],
      `${model} should map to ${COLD_START_BUDGET_MS[model]} ms`,
    );
  }
});

test("each model in the table has a sensible budget", () => {
  // Lock in the issue's published numbers so a careless edit can't
  // silently halve the budget for a single model.
  assert.equal(COLD_START_BUDGET_MS["claude-haiku-4-5"], 30_000);
  assert.equal(COLD_START_BUDGET_MS["claude-sonnet-4-6"], 90_000);
  assert.equal(COLD_START_BUDGET_MS["claude-opus-4-6"], 180_000);
  assert.equal(COLD_START_BUDGET_MS["claude-opus-4-7"], 180_000);
});

test("unknown model falls back to DEFAULT_COLD_START_BUDGET_MS", () => {
  assert.equal(
    resolveConnectionTimeoutMs({ override: null, model: "gpt-5" }),
    DEFAULT_COLD_START_BUDGET_MS,
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: null, model: "gemini-2.5-pro" }),
    DEFAULT_COLD_START_BUDGET_MS,
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: null, model: "" }),
    DEFAULT_COLD_START_BUDGET_MS,
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: null, model: undefined }),
    DEFAULT_COLD_START_BUDGET_MS,
  );
});

test("valid in-range override wins over model default", () => {
  // Pick a number that's clearly distinct from any tabled default
  // so a "we forgot to read the override" bug would surface.
  const explicit = 90_000;
  for (const model of [...Object.keys(COLD_START_BUDGET_MS), "gpt-5", "unknown"]) {
    assert.equal(
      resolveConnectionTimeoutMs({ override: explicit, model }),
      explicit,
      `override ${explicit} should win for model=${model}`,
    );
  }
});

test("override at the exact minimum boundary is accepted", () => {
  assert.equal(
    resolveConnectionTimeoutMs({ override: MIN_COLD_START_BUDGET_MS, model: "claude-sonnet-4-6" }),
    MIN_COLD_START_BUDGET_MS,
  );
});

test("override at the exact maximum boundary is accepted", () => {
  assert.equal(
    resolveConnectionTimeoutMs({ override: MAX_COLD_START_BUDGET_MS, model: "claude-sonnet-4-6" }),
    MAX_COLD_START_BUDGET_MS,
  );
});

test("override below minimum falls through to model default", () => {
  assert.equal(
    resolveConnectionTimeoutMs({ override: MIN_COLD_START_BUDGET_MS - 1, model: "claude-sonnet-4-6" }),
    COLD_START_BUDGET_MS["claude-sonnet-4-6"],
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: 1, model: "claude-haiku-4-5" }),
    COLD_START_BUDGET_MS["claude-haiku-4-5"],
  );
});

test("override above maximum falls through to model default", () => {
  assert.equal(
    resolveConnectionTimeoutMs({ override: MAX_COLD_START_BUDGET_MS + 1, model: "claude-opus-4-7"}),
    COLD_START_BUDGET_MS["claude-opus-4-7"],
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: 99_999_999, model: "claude-opus-4-7" }),
    COLD_START_BUDGET_MS["claude-opus-4-7"],
  );
});

test("zero and negative overrides fall through", () => {
  assert.equal(
    resolveConnectionTimeoutMs({ override: 0, model: "claude-sonnet-4-6" }),
    COLD_START_BUDGET_MS["claude-sonnet-4-6"],
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: -1000, model: "claude-sonnet-4-6" }),
    COLD_START_BUDGET_MS["claude-sonnet-4-6"],
  );
});

test("non-finite override values fall through", () => {
  assert.equal(
    resolveConnectionTimeoutMs({ override: NaN, model: "claude-sonnet-4-6" }),
    COLD_START_BUDGET_MS["claude-sonnet-4-6"],
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: Infinity, model: "claude-sonnet-4-6" }),
    COLD_START_BUDGET_MS["claude-sonnet-4-6"],
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: -Infinity, model: "claude-sonnet-4-6" }),
    COLD_START_BUDGET_MS["claude-sonnet-4-6"],
  );
});

test("non-number override values fall through", () => {
  // Common "stored as the wrong type" scenarios — protect against a
  // user editing data.json by hand and entering a string, or a
  // future migration accidentally storing strings.
  assert.equal(
    resolveConnectionTimeoutMs({ override: "60000", model: "claude-sonnet-4-6" }),
    COLD_START_BUDGET_MS["claude-sonnet-4-6"],
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: undefined, model: "claude-sonnet-4-6" }),
    COLD_START_BUDGET_MS["claude-sonnet-4-6"],
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: {}, model: "claude-sonnet-4-6" }),
    COLD_START_BUDGET_MS["claude-sonnet-4-6"],
  );
  assert.equal(
    resolveConnectionTimeoutMs({ override: true, model: "claude-sonnet-4-6" }),
    COLD_START_BUDGET_MS["claude-sonnet-4-6"],
  );
});

test("bounds are sane: MIN < every tabled default < MAX", () => {
  // If someone retunes the bounds without thinking about the table,
  // a model's default could fall outside [MIN, MAX] and a user
  // setting that exact value would be rejected as out-of-range
  // even though it matches a published default. Lock that down.
  for (const [model, budget] of Object.entries(COLD_START_BUDGET_MS)) {
    assert.ok(
      budget >= MIN_COLD_START_BUDGET_MS && budget <= MAX_COLD_START_BUDGET_MS,
      `${model} default ${budget} should fall within [${MIN_COLD_START_BUDGET_MS}, ${MAX_COLD_START_BUDGET_MS}]`,
    );
  }
  assert.ok(
    DEFAULT_COLD_START_BUDGET_MS >= MIN_COLD_START_BUDGET_MS
      && DEFAULT_COLD_START_BUDGET_MS <= MAX_COLD_START_BUDGET_MS,
    "DEFAULT_COLD_START_BUDGET_MS should fall within bounds",
  );
});

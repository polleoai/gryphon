/**
 * v1.7.0 settings migration: persisted `settings.model` values that
 * used the old generic aliases (`haiku`/`sonnet`/`opus`/`opus[1m]`) must
 * be rewritten to concrete model IDs at load time. The CLI used to
 * resolve `sonnet` → "latest Sonnet" server-side, but on boxes whose
 * installed CLI predates Sonnet 4.6 the alias still resolves to
 * Sonnet 4.5 (200K context) — silently downgrading long-context users.
 *
 * Two invariants under test:
 *   1. Every alias in the migration table maps to a value that exists
 *      in the canonical MODELS dropdown (no orphan migrations).
 *   2. `_migrateSettings` rewrites the alias when present and leaves
 *      already-concrete IDs untouched (idempotent).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { MODELS, MODEL_ALIAS_MIGRATION } = require("../src/constants");
const GryphonPlugin = require("../src/plugin");

test("every alias in MODEL_ALIAS_MIGRATION maps to a value present in MODELS", () => {
  const modelValues = new Set(MODELS.map((m) => m.value));
  for (const [alias, concreteId] of Object.entries(MODEL_ALIAS_MIGRATION)) {
    assert.ok(
      modelValues.has(concreteId),
      `alias ${alias} migrates to ${concreteId}, which is not in MODELS`,
    );
  }
});

test("migration covers exactly the v1.6.2 alias set (no more, no less)", () => {
  // If new aliases are added later, this test forces the author to
  // update both the table and this expectation — preventing silent
  // additions that might shadow new concrete IDs.
  const expectedAliases = ["haiku", "sonnet", "opus", "opus[1m]"];
  assert.deepEqual(
    Object.keys(MODEL_ALIAS_MIGRATION).sort(),
    expectedAliases.sort(),
  );
});

test("_migrateSettings rewrites old alias to concrete ID", () => {
  const stub = { settings: { model: "sonnet" } };
  GryphonPlugin.prototype._migrateSettings.call(stub, {});
  assert.equal(stub.settings.model, "claude-sonnet-4-6");
});

test("_migrateSettings rewrites opus[1m] to claude-opus-4-8 (preserves intent)", () => {
  const stub = { settings: { model: "opus[1m]" } };
  GryphonPlugin.prototype._migrateSettings.call(stub, {});
  assert.equal(stub.settings.model, "claude-opus-4-8");
});

test("_migrateSettings is idempotent on already-concrete model IDs", () => {
  for (const concreteId of MODELS.map((m) => m.value)) {
    const stub = { settings: { model: concreteId } };
    GryphonPlugin.prototype._migrateSettings.call(stub, {});
    assert.equal(stub.settings.model, concreteId,
      `migration must leave concrete ID ${concreteId} unchanged`);
  }
});

test("_migrateSettings tolerates missing model field", () => {
  const stub = { settings: {} };
  GryphonPlugin.prototype._migrateSettings.call(stub, {});
  // Undefined → undefined; the migration only rewrites string values.
  assert.equal(stub.settings.model, undefined);
});

test("_migrateSettings ignores non-string model values", () => {
  const stub = { settings: { model: 42 } };
  GryphonPlugin.prototype._migrateSettings.call(stub, {});
  assert.equal(stub.settings.model, 42);
});

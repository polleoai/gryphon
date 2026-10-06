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
  assert.equal(stub.settings.model, "claude-sonnet-5-5");
});

test("_migrateSettings rewrites opus[1m] to claude-opus-5-5 (preserves intent)", () => {
  const stub = { settings: { model: "opus[1m]" } };
  GryphonPlugin.prototype._migrateSettings.call(stub, {});
  assert.equal(stub.settings.model, "claude-opus-5-5");
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

// ---------- retired-model migration ----------

const migrateRetired = (settings) =>
  GryphonPlugin.prototype._migrateRetiredModels.call({ settings });

test("_migrateRetiredModels rewrites a hidden model to its successor", () => {
  const settings = { model: "claude-opus-4-8", fallbackModel: "" };
  const changes = migrateRetired(settings);
  assert.equal(settings.model, "claude-opus-5-5");
  assert.deepEqual(changes, [{ key: "model", from: "claude-opus-4-8", to: "claude-opus-5-5" }]);
});

test("_migrateRetiredModels covers fallbackModel too", () => {
  const settings = { model: "claude-sonnet-5-5", fallbackModel: "gemini-2.5-flash" };
  migrateRetired(settings);
  assert.equal(settings.model, "claude-sonnet-5-5", "current id untouched");
  assert.equal(settings.fallbackModel, "gemini-3.7-flash");
});

test("_migrateRetiredModels rewrites removed (vendor-shutdown) ids", () => {
  const settings = { model: "o4-mini", fallbackModel: "gpt-5" };
  migrateRetired(settings);
  assert.equal(settings.model, "gpt-5.6-terra");
  assert.equal(settings.fallbackModel, "gpt-6.1-sol");
});

test("_migrateRetiredModels is idempotent", () => {
  const settings = { model: "claude-sonnet-4-6", fallbackModel: "" };
  migrateRetired(settings);
  assert.deepEqual(migrateRetired(settings), [], "second load changes nothing");
});

test("_migrateRetiredModels leaves unknown and empty ids alone (forward-compat)", () => {
  const settings = { model: "claude-future-9-9", fallbackModel: "" };
  assert.deepEqual(migrateRetired(settings), []);
  assert.equal(settings.model, "claude-future-9-9");
});

test("legacy alias then retirement lands on a current id in one load", () => {
  // `sonnet` → alias table → claude-sonnet-5-5 (current), so no retirement
  // hop is needed; the two tables must never chain into a hidden id.
  const stub = { settings: { model: "sonnet", fallbackModel: "" } };
  GryphonPlugin.prototype._migrateSettings.call(stub, {});
  GryphonPlugin.prototype._migrateRetiredModels.call(stub);
  assert.ok(MODELS.some((m) => m.value === stub.settings.model), stub.settings.model);
});

test("loadSettings survives a failed save of the retired-model migration", async () => {
  // Read-only vault / sync lock: the plugin must still load, with the
  // migrated value in memory.
  const plugin = Object.create(GryphonPlugin.prototype);
  plugin.loadData = async () => ({ model: "claude-opus-4-8" });
  let saveAttempts = 0;
  plugin.saveData = async () => { saveAttempts++; throw new Error("EROFS"); };
  plugin._dropStalePerReloadSessionIds = () => {};
  plugin._stripStaleAntigravityHooks = () => {};
  const origWarn = console.warn;
  console.warn = () => {};
  try { await plugin.loadSettings(); } finally { console.warn = origWarn; }
  assert.equal(saveAttempts, 1);
  assert.equal(plugin.settings.model, "claude-opus-5-5");
});

test("loadSettings does not save when nothing was retired", async () => {
  const plugin = Object.create(GryphonPlugin.prototype);
  plugin.loadData = async () => ({ model: "claude-sonnet-5-5" });
  let saved = false;
  plugin.saveData = async () => { saved = true; };
  plugin._dropStalePerReloadSessionIds = () => {};
  plugin._stripStaleAntigravityHooks = () => {};
  await plugin.loadSettings();
  assert.equal(saved, false);
});

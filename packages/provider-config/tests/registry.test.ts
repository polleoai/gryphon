const { test } = require("node:test");
const assert = require("node:assert/strict");
const registry = require("../src/registry");

test("registry exports allModels(), modelsByVendor(), priceFor()", () => {
  assert.equal(typeof registry.allModels, "function");
  assert.equal(typeof registry.modelsByVendor, "function");
  assert.equal(typeof registry.priceFor, "function");
});

test("modelsByVendor('anthropic') returns Anthropic-only entries", () => {
  const anthropicModels = registry.modelsByVendor("anthropic");
  assert.ok(anthropicModels.length >= 3, "should have at least 3 Anthropic models");
  for (const m of anthropicModels) {
    assert.equal(m.vendor, "anthropic", `${m.id} should be vendor=anthropic`);
    assert.ok(m.id.startsWith("claude-"), `${m.id} should start with claude-`);
  }
});

test("priceFor('claude-sonnet-4-6', 'anthropic') returns the pricing object", () => {
  const p = registry.priceFor("claude-sonnet-4-6", "anthropic");
  assert.equal(p.input, 3.00);
  assert.equal(p.output, 15.00);
});

test("priceFor unknown id falls back to vendor default", () => {
  const p = registry.priceFor("claude-future-9-9", "anthropic");
  assert.equal(p.input, 3.00, "Anthropic _default uses Sonnet 4.6 pricing");
});

test("aliasFor('opus', 'anthropic') returns claude-opus-4-8", () => {
  assert.equal(registry.aliasFor("opus", "anthropic"), "claude-opus-4-8");
});

test("aliasFor('opus', 'openai') returns gpt-5.4 (current cost-ceiling decision)", () => {
  assert.equal(registry.aliasFor("opus", "openai"), "gpt-5.4");
});

test("aliasFor('opus', 'google') returns gemini-2.5-pro", () => {
  assert.equal(registry.aliasFor("opus", "google"), "gemini-2.5-pro");
});

test("defaultModelFor returns the marked default per vendor", () => {
  assert.equal(registry.defaultModelFor("anthropic"), "claude-sonnet-4-6");
  assert.equal(registry.defaultModelFor("openai"), "gpt-5.4-mini");
  assert.equal(registry.defaultModelFor("google"), "gemini-2.5-flash");
});

test("dropdownFor('anthropic') returns ordered {id,label,desc} entries", () => {
  const opts = registry.dropdownFor("anthropic");
  assert.ok(opts.length >= 3);
  for (const o of opts) {
    assert.equal(typeof o.id, "string");
    assert.equal(typeof o.label, "string");
    assert.equal(typeof o.desc, "string");
  }
});

test("isKnownModel correctly identifies registry entries", () => {
  assert.equal(registry.isKnownModel("claude-sonnet-4-6"), true);
  assert.equal(registry.isKnownModel("gpt-5.5"), true);
  assert.equal(registry.isKnownModel("gemini-2.5-flash"), true);
  assert.equal(registry.isKnownModel("nonexistent-model"), false);
});

test("contextTokensFor returns 1M for Sonnet 4.6 (Anthropic)", () => {
  assert.equal(registry.contextTokensFor("claude-sonnet-4-6"), 1_000_000);
});

test("coldStartMsFor returns 90s for Sonnet 4.6", () => {
  assert.equal(registry.coldStartMsFor("claude-sonnet-4-6"), 90_000);
});

test("legacyAliasMigrationFor('anthropic') returns the old-alias map", () => {
  const m = registry.legacyAliasMigrationFor("anthropic");
  assert.equal(m["haiku"], "claude-haiku-4-5");
  assert.equal(m["sonnet"], "claude-sonnet-4-6");
  assert.equal(m["opus"], "claude-opus-4-8");
  assert.equal(m["opus[1m]"], "claude-opus-4-8");
});

test("codexCliSupported subset of OpenAI models", () => {
  const set = registry.codexCliSupportedModels();
  assert.ok(set.has("gpt-5.5"));
  assert.ok(set.has("gpt-5.4"));
  assert.ok(set.has("gpt-5.4-mini"));
  assert.equal(set.has("gpt-5"), false, "gpt-5 NOT in Codex CLI ChatGPT-auth whitelist");
  assert.equal(set.has("gpt-4o"), false);
});

test("priceFor with unknown vendor throws (Fix 2 — replaces old warn-once behavior)", () => {
  // priceFor now throws immediately on unknown vendor rather than silently
  // falling back to OpenAI pricing (which would 4× underbill Anthropic calls
  // on a vendor typo). This is the Fix 2 behavior update — the old warn-once
  // test is replaced by the new throws test below.
  assert.throws(
    () => registry.priceFor("nonexistent-id", "test-vendor-unknown-throw"),
    /unknown vendor "test-vendor-unknown-throw"/,
  );
});

test("defaultModelFor with unknown vendor warns once via console.warn", () => {
  const captured = [];
  const orig = console.warn;
  console.warn = (...a) => captured.push(a.join(" "));
  try {
    registry.defaultModelFor("test-vendor-fix3-A");
    registry.defaultModelFor("test-vendor-fix3-A");
    const matching = captured.filter((s) => s.includes("test-vendor-fix3-A"));
    assert.equal(matching.length, 1);
  } finally {
    console.warn = orig;
  }
});

test("aliasFor identity passthrough for concrete vendor id", () => {
  // Documented behavior: passing a concrete id that belongs to the vendor
  // returns the id unchanged.
  assert.equal(registry.aliasFor("claude-sonnet-4-6", "anthropic"), "claude-sonnet-4-6");
  assert.equal(registry.aliasFor("gpt-5.5", "openai"), "gpt-5.5");
  // Cross-vendor mismatch still returns null.
  assert.equal(registry.aliasFor("gpt-5.5", "anthropic"), null);
});

// Fix 1: MODELS array immutability
test("MODELS array is frozen and allModels() returns a copy", () => {
  const ms = registry.allModels();
  // The returned array is a copy — mutating it doesn't affect the next call
  const ms2 = registry.allModels();
  assert.notEqual(ms, ms2, "allModels should return distinct array instances");
  // And modifying the copy does not corrupt the registry
  ms.push({ id: "evil", vendor: "evil" });
  const ms3 = registry.allModels();
  assert.equal(ms3.find((m) => m.id === "evil"), undefined, "push on returned array must not corrupt registry");
});

test("Individual MODEL entries are frozen (Fix 1)", () => {
  const m = registry.allModels()[0];
  assert.ok(Object.isFrozen(m), "model entry should be frozen");
  const originalId = m.id;
  // In sloppy mode the assignment is silently ignored on a frozen object;
  // in strict mode it throws. Either way the value must not change.
  try { m.id = "tampered"; } catch (_) { /* strict mode — expected */ }
  assert.equal(m.id, originalId, "frozen entry: id must not be writable");
});

// Fix 2: priceFor throws on unknown vendor
test("priceFor throws on unknown vendor (Fix 2)", () => {
  assert.throws(
    () => registry.priceFor("some-id", "antrhopic"),
    /unknown vendor "antrhopic"/,
  );
});

// Fix 10: isDefault uniqueness per vendor
test("each vendor has at most one isDefault: true entry (Fix 10)", () => {
  for (const vendor of ["anthropic", "openai", "google"]) {
    const defaults = registry.modelsByVendor(vendor).filter((m) => m.isDefault);
    assert.ok(
      defaults.length <= 1,
      `${vendor} has ${defaults.length} models with isDefault=true: ${defaults.map((m) => m.id).join(", ")} — should be 0 or 1`,
    );
  }
});

// Fix 11: contextTokensFor / coldStartMsFor with 0 values
test("contextTokensFor returns value when present, null when absent (Fix 11)", () => {
  // A model we know has a value
  assert.equal(registry.contextTokensFor("claude-sonnet-4-6"), 1_000_000);
  // An unknown id returns null
  assert.equal(registry.contextTokensFor("nonexistent-id"), null);
});

test("coldStartMsFor returns value when present, null when absent (Fix 11)", () => {
  assert.equal(registry.coldStartMsFor("claude-sonnet-4-6"), 90_000);
  assert.equal(registry.coldStartMsFor("nonexistent-id"), null);
});

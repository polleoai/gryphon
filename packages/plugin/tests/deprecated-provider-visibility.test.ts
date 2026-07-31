/**
 * Deprecated providers: hidden from the dropdown, but never hidden FROM THE
 * PERSON ALREADY USING ONE.
 *
 * Google discontinued the Gemini CLI, so offering it to someone picking a
 * provider for the first time is offering a dead end. But deleting the option
 * outright is the more dangerous move: Obsidian's `setValue()` on an id with
 * no matching <option> leaves the select showing some OTHER provider while
 * `settings.providerPreference` still says "gemini-cli". The user then reads
 * the wrong provider off their own settings screen, and any support
 * conversation starts from a false premise.
 *
 * So: hidden by default, always visible when it is the current value.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  PROVIDER_PREFS,
  FALLBACK_PROVIDER_PREFS,
  visibleProviderPrefs,
} = require("../src/constants");

const values = (list: any) => list.map((p: any) => p.value);

test("gemini-cli is marked deprecated in the catalogue", () => {
  const entry = PROVIDER_PREFS.find((p: any) => p.value === "gemini-cli");
  assert.ok(entry, "the entry must remain so existing users still get a real label");
  assert.equal(entry.deprecated, true);
  assert.match(entry.label, /discontinued/i, "the label must say so plainly");
});

test("a new user is not offered the discontinued provider", () => {
  assert.ok(!values(visibleProviderPrefs(PROVIDER_PREFS, "auto")).includes("gemini-cli"));
  assert.ok(!values(visibleProviderPrefs(PROVIDER_PREFS, null)).includes("gemini-cli"));
  assert.ok(!values(visibleProviderPrefs(PROVIDER_PREFS, "anthropic-api")).includes("gemini-cli"));
});

test("a user already on gemini-cli still sees it selected", () => {
  const shown = values(visibleProviderPrefs(PROVIDER_PREFS, "gemini-cli"));
  assert.ok(
    shown.includes("gemini-cli"),
    "hiding the selected option makes the select display a provider the user is not on",
  );
});

test("every non-deprecated provider survives the filter", () => {
  const shown = values(visibleProviderPrefs(PROVIDER_PREFS, "auto"));
  for (const v of ["anthropic-api", "claude-code", "openai-api", "google-api",
                   "codex-cli", "antigravity-cli", "auto"]) {
    assert.ok(shown.includes(v), `${v} must still be offered`);
  }
});

test("the fallback picker follows the same rule, keyed on its own setting", () => {
  assert.ok(!values(visibleProviderPrefs(FALLBACK_PROVIDER_PREFS, "none")).includes("gemini-cli"));
  assert.ok(values(visibleProviderPrefs(FALLBACK_PROVIDER_PREFS, "gemini-cli")).includes("gemini-cli"));
  // "No fallback" is not a provider and must never be filtered out.
  assert.ok(values(visibleProviderPrefs(FALLBACK_PROVIDER_PREFS, "none")).includes("none"));
});

test("the Google API provider is untouched — it is a different provider", () => {
  // google-api is the API-key path and is unaffected by the CLI's retirement.
  const entry = PROVIDER_PREFS.find((p: any) => p.value === "google-api");
  assert.ok(entry && !entry.deprecated);
});

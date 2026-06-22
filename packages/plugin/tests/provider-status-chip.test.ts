/**
 * provider-status-chip.test.ts — acceptance tests for issue #16 (settings surface).
 *
 * After the Provider dropdown, `renderGryphonSettings` draws an inline status
 * chip on the Provider row's description element when the selected provider
 * is NOT usable (e.g. an API kind with no key). The chip is the PROACTIVE,
 * before-send signal — the only surface that can catch a misconfigured
 * provider when no request (and therefore no reactive failover) ever fires.
 *
 * Happy path stays quiet: a usable provider renders no chip.
 *
 * The chip text reads from the @gryphon/provider-runtime readiness kernel
 * (describeProviderReadiness + humanizeFailureReason), so it can never drift
 * from createProvider's real selection logic. Rendered with createSpan and
 * the existing host-contract typeof-guard discipline — no new hard Obsidian
 * dependency. The check is a cheap presence test: NO network call.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const obsidian = require("./_stubs/obsidian.js");
const { renderGryphonSettings } = require("../src/settings-view");

const makeContainer = () => obsidian._el();
const findRow = (container, name) =>
  container.__settings.find((s) => s.name === name);

// The chip lives on the Provider row's descEl (the same anchor pattern the
// API-key status lines use). Collect every text fragment recorded there.
const providerDescText = (container) => {
  const row = findRow(container, "Provider");
  if (!row || !row.descEl) return "";
  return (row.descEl.__created || []).map((c) => c.text || "").join(" ");
};

function withoutGoogleKey(fn) {
  const saved = process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try { return fn(); }
  finally { if (saved !== undefined) process.env.GOOGLE_API_KEY = saved; }
}

test("issue #16: google-api + no key → chip text names 'no API key'", () => {
  withoutGoogleKey(() => {
    const host = { settings: { providerPreference: "google-api" }, saveSettings: async () => {} };
    const container = makeContainer();

    renderGryphonSettings(host, container);

    const text = providerDescText(container);
    assert.match(text, /no API key/, "an unconfigured provider must render the proactive warning chip");
    assert.match(text, /won't be used/, "the chip must say the selected provider won't be used");
  });
});

test("issue #16: google-api + key → no chip (happy path stays quiet)", () => {
  withoutGoogleKey(() => {
    const host = {
      settings: { providerPreference: "google-api", googleApiKey: "AIza-test" },
      saveSettings: async () => {},
    };
    const container = makeContainer();

    renderGryphonSettings(host, container);

    const text = providerDescText(container);
    assert.doesNotMatch(text, /won't be used/, "a configured provider must NOT render a warning chip");
  });
});

test("issue #16: rendering the chip makes NO network call (cheap presence check)", () => {
  withoutGoogleKey(() => {
    const origFetch = global.fetch;
    let networkTouched = false;
    global.fetch = () => { networkTouched = true; throw new Error("network must not be touched"); };
    try {
      const host = { settings: { providerPreference: "google-api" }, saveSettings: async () => {} };
      renderGryphonSettings(host, makeContainer());
      assert.equal(networkTouched, false, "the settings chip must not validate keys over the network");
    } finally {
      global.fetch = origFetch;
    }
  });
});

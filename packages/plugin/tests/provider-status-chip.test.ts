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

const { _el, _allSettings } = require("./_stubs/obsidian.ts");
const { renderGryphonSettings } = require("../src/settings-view");

const makeContainer = () => _el();
const findRow = (container, name) =>
  _allSettings(container).find((s) => s.name === name);

// The readiness warning lives ON the Provider dropdown now: a red border plus
// the reason on hover (attachHoverTooltip stamps the text onto
// `selectEl._gryphonTip`). No separate warning icon.
const providerSelect = (container) => {
  const row = findRow(container, "Provider");
  return row && row.controls.find((c) => c.type === "dropdown");
};

function withoutGoogleKey(fn) {
  const saved = process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try { return fn(); }
  finally { if (saved !== undefined) process.env.GOOGLE_API_KEY = saved; }
}

test("issue #16: unusable provider → red-bordered Provider dropdown, reason on hover (no separate icon)", () => {
  withoutGoogleKey(() => {
    const c = makeContainer();
    renderGryphonSettings({ settings: { providerPreference: "google-api" }, saveSettings: async () => {} }, c);
    const drop = providerSelect(c);
    assert.ok(drop.selectEl.classList.contains("gryphon-input-error"), "unusable selection → red border on the dropdown");
    const tip = drop.selectEl._gryphonTip || "";
    assert.match(tip, /no API key/i, "hovering the dropdown reveals the specific reason");
    assert.match(tip, /won't be used/i, "…and the consequence");
  });
});

test("issue #16: usable provider → no red border, no hover warning (happy path stays quiet)", () => {
  withoutGoogleKey(() => {
    const c = makeContainer();
    renderGryphonSettings({ settings: { providerPreference: "google-api", googleApiKey: "AIza-test" }, saveSettings: async () => {} }, c);
    const drop = providerSelect(c);
    assert.ok(!drop.selectEl.classList.contains("gryphon-input-error"), "usable selection → no red border");
    assert.ok(!drop.selectEl._gryphonTip, "usable selection → no hover warning text");
  });
});

test("buildProviderUnreadyNotice: unusable provider → actionable close notice; usable → null", () => {
  withoutGoogleKey(() => {
    const { buildProviderUnreadyNotice } = require("../src/settings-view");
    const warn = buildProviderUnreadyNotice({ settings: { providerPreference: "google-api" } });
    assert.match(warn, /Google Gemini API/, "names the selected provider");
    assert.match(warn, /no API key/i, "names the reason");
    assert.match(warn, /won't be used/i, "states the consequence");
    assert.match(warn, /Settings/, "tells the user where to fix it");
    const ok = buildProviderUnreadyNotice({
      settings: { providerPreference: "google-api", googleApiKey: "AIza-test" },
    });
    assert.equal(ok, null, "a usable provider produces no close warning");
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

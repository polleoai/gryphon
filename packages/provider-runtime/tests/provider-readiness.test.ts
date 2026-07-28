/**
 * Issue #16 — proactive provider-readiness signal.
 *
 * The host-agnostic kernel exported from @gryphon/provider-runtime:
 *   - describeProviderReadiness(plugin, preference?) → { ready, reason, kind }
 *   - humanizeFailureReason(reason) → string
 *   - friendlyProviderLabel(kind) → string
 *
 * These are the single source of truth both UI surfaces read from (the
 * Settings status chip + the chat fallback attribution), so the chip can
 * never drift from createProvider's real selection logic. The contract is
 * PURE — settings/env presence + the same local binary detection the factory
 * already uses, NO network / fetch / API call. The tests assert all three.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// The factory transitively loads `obsidian` (anthropic-api's permission gate).
// Stub it the same way the failover-kernel test does.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

// Stub binary detectors so tests don't depend on the host system.
const utils = require("../src/utils");
const origCodex = utils.findCodexBinary;
const origGemini = utils.findGeminiBinary;
const origClaude = utils.findClaudeBinary;
const origAntigravity = utils.findAntigravityBinary;
function stubBinaries({ codex = null, gemini = null, claude = null, antigravity = null } = {}) {
  utils.findCodexBinary = () => codex;
  utils.findGeminiBinary = () => gemini;
  utils.findClaudeBinary = () => claude;
  utils.findAntigravityBinary = () => antigravity;
}
function restoreBinaries() {
  utils.findCodexBinary = origCodex;
  utils.findGeminiBinary = origGemini;
  utils.findClaudeBinary = origClaude;
  utils.findAntigravityBinary = origAntigravity;
}
function freshEnv(fn) {
  const snap = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try { return fn(); }
  finally { Object.assign(process.env, snap); }
}

const runtime = require("../src/index");
const { describeProviderReadiness, humanizeFailureReason, friendlyProviderLabel } = runtime;

// ── exported from the package index (Athena consumes the same signal) ──

test("issue #16: readiness helpers exported from index", () => {
  assert.equal(typeof describeProviderReadiness, "function");
  assert.equal(typeof humanizeFailureReason, "function");
  assert.equal(typeof friendlyProviderLabel, "function");
});

// ── describeProviderReadiness ─────────────────────────────────────────

test("issue #16: google-api + no key → { ready:false, reason:'no-api-key' }", () => {
  freshEnv(() => {
    stubBinaries({});
    try {
      const plugin = { settings: { providerPreference: "google-api" } };
      assert.deepEqual(describeProviderReadiness(plugin), {
        ready: false, reason: "no-api-key", kind: null,
      });
    } finally { restoreBinaries(); }
  });
});

test("issue #16: google-api + key → ready", () => {
  freshEnv(() => {
    stubBinaries({});
    try {
      const plugin = { settings: { providerPreference: "google-api", googleApiKey: "AIza-test" } };
      const r = describeProviderReadiness(plugin);
      assert.equal(r.ready, true);
      assert.equal(r.reason, null);
      assert.equal(r.kind, "google-api");
    } finally { restoreBinaries(); }
  });
});

test("issue #16: 'auto' + exactly one key → ready (kind = the resolvable provider)", () => {
  freshEnv(() => {
    stubBinaries({}); // no CLIs, so the single API key is what resolves
    try {
      const plugin = { settings: { providerPreference: "auto", openaiApiKey: "sk-test" } };
      const r = describeProviderReadiness(plugin);
      assert.equal(r.ready, true);
      assert.equal(r.kind, "openai-api");
    } finally { restoreBinaries(); }
  });
});

test("issue #16: claude-code + no binary → { ready:false, reason:'construct-null' }", () => {
  freshEnv(() => {
    stubBinaries({}); // no claude binary on disk
    try {
      const plugin = { settings: { providerPreference: "claude-code" } };
      assert.deepEqual(describeProviderReadiness(plugin), {
        ready: false, reason: "construct-null", kind: null,
      });
    } finally { restoreBinaries(); }
  });
});

test("issue #19: antigravity-cli + no binary → { ready:false, reason:'construct-null' }", () => {
  freshEnv(() => {
    stubBinaries({}); // no agy binary on disk
    try {
      const plugin = { settings: { providerPreference: "antigravity-cli" } };
      assert.deepEqual(describeProviderReadiness(plugin), {
        ready: false, reason: "construct-null", kind: null,
      });
    } finally { restoreBinaries(); }
  });
});

test("issue #16: explicit preference arg overrides plugin.settings.providerPreference", () => {
  freshEnv(() => {
    stubBinaries({});
    try {
      // settings say google-api (no key), but we ask about openai-api explicitly.
      const plugin = { settings: { providerPreference: "google-api", openaiApiKey: "sk-test" } };
      const r = describeProviderReadiness(plugin, "openai-api");
      assert.equal(r.ready, true);
      assert.equal(r.kind, "openai-api");
    } finally { restoreBinaries(); }
  });
});

test("issue #16: describeProviderReadiness makes NO network call (cheap presence check)", () => {
  freshEnv(() => {
    stubBinaries({});
    const origFetch = global.fetch;
    let networkTouched = false;
    global.fetch = () => { networkTouched = true; throw new Error("network must not be touched"); };
    try {
      describeProviderReadiness({ settings: { providerPreference: "google-api" } });
      describeProviderReadiness({ settings: { providerPreference: "anthropic-api", anthropicApiKey: "sk-x" } });
      assert.equal(networkTouched, false, "readiness must not hit the network");
    } finally {
      global.fetch = origFetch;
      restoreBinaries();
    }
  });
});

// ── humanizeFailureReason ─────────────────────────────────────────────

test("issue #16: humanizeFailureReason maps every reason to the issue's shape", () => {
  assert.equal(humanizeFailureReason("no-api-key"), "no API key");
  assert.equal(humanizeFailureReason("auth"), "invalid API key");
  assert.equal(humanizeFailureReason("insufficient-credit"), "out of credit");
  assert.equal(humanizeFailureReason("quota"), "quota exceeded");
  assert.equal(humanizeFailureReason("rate-limit"), "rate-limited");
  assert.equal(humanizeFailureReason("construct-null"), "not found");
});

// ── friendlyProviderLabel ─────────────────────────────────────────────

test("issue #16: friendlyProviderLabel maps every provider kind", () => {
  assert.equal(friendlyProviderLabel("anthropic-api"), "Anthropic API");
  assert.equal(friendlyProviderLabel("claude-code"), "Claude Code CLI");
  assert.equal(friendlyProviderLabel("openai-api"), "OpenAI API");
  assert.equal(friendlyProviderLabel("google-api"), "Google Gemini API");
  assert.equal(friendlyProviderLabel("codex-cli"), "Codex CLI");
  assert.equal(friendlyProviderLabel("gemini-cli"), "Gemini CLI");
  assert.equal(friendlyProviderLabel("antigravity-cli"), "Antigravity CLI");
});

/**
 * Issue #15 — chat-view failover orchestration loop.
 *
 * `_runFailover(activeKind, attempt)` is the thin orchestration layer that
 * sits on top of the provider-runtime kernel (classifyProviderFailure /
 * resolveFallback). It runs the active provider, and on an AVAILABILITY
 * failure (construct-null OR a send error in the no-key / auth /
 * insufficient-credit / quota / rate-limit class) retries ONCE with a
 * user-configured fallback — then stamps the result transparency signal
 * (requestedProvider / servedBy / fellBack / reason).
 *
 * `attempt(kind, modelOverride)` is the re-runnable construct+wire+send unit
 * supplied by sendMessage. It resolves to one of:
 *   { ok: true,  provider, result }          — sent successfully
 *   { ok: false, provider, error }           — constructed, send threw
 *   { ok: false, provider: null, error: null } — construct returned null
 *
 * Tested via direct method invocation with minimal stubs (the same pattern
 * as settings-changed-event.test.ts / consumer-subprocess-teardown.test.ts).
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

const { GryphonChatView } = require("../src/chat-view");

function makeView(settings) {
  const view = Object.create(GryphonChatView.prototype);
  view.plugin = { settings: settings || {} };
  return view;
}

// A factory for `attempt` stubs. `script` maps a call index → outcome.
function recordingAttempt(outcomes) {
  const calls = [];
  const attempt = async (kind, modelOverride) => {
    const idx = calls.length;
    calls.push({ kind, modelOverride });
    const o = outcomes[idx];
    if (!o) throw new Error(`unexpected attempt #${idx} for kind=${kind}`);
    return o;
  };
  attempt.calls = calls;
  return attempt;
}

const okResult = (text) => ({ text: text || "answer", cost: 0, cumulativeCost: 0, sessionId: null, duration: 1, contextTokens: 0 });

// ── scenario 1: active serves → no failover ───────────────────────────

test("issue #15: active provider serves → fellBack false, servedBy === requested", async () => {
  const view = makeView({ providerPreference: "anthropic-api", fallbackProviderPreference: "claude-code", claudePath: "/usr/bin/claude" });
  const attempt = recordingAttempt([{ ok: true, provider: {}, result: okResult("hi") }]);

  const decision = await view._runFailover("anthropic-api", attempt);

  assert.equal(decision.outcome, "served");
  assert.equal(decision.fellBack, false);
  assert.equal(decision.requestedProvider, "anthropic-api");
  assert.equal(decision.servedBy, "anthropic-api");
  assert.equal(decision.reason, null);
  assert.equal(attempt.calls.length, 1, "must not attempt a fallback when active serves");
  // Result is stamped with the transparency signal.
  assert.equal(decision.result.fellBack, false);
  assert.equal(decision.result.servedBy, "anthropic-api");
});

// ── scenario 2 (issue verify #1): construct-null → fallback serves ────

test("issue #15: construct-null active → fallback serves, reason 'no-api-key'", async () => {
  // Active = google-api with NO key (construct returns null). Fallback = claude-code.
  const view = makeView({ providerPreference: "google-api", fallbackProviderPreference: "claude-code", claudePath: "/usr/bin/claude" });
  const attempt = recordingAttempt([
    { ok: false, provider: null, error: null },               // active construct-null
    { ok: true, provider: {}, result: okResult("from claude") }, // fallback serves
  ]);

  const decision = await view._runFailover("google-api", attempt);

  assert.equal(decision.outcome, "served");
  assert.equal(decision.fellBack, true);
  assert.equal(decision.requestedProvider, "google-api");
  assert.equal(decision.servedBy, "claude-code");
  assert.equal(decision.reason, "no-api-key", "construct-null with no key reads as no-api-key");
  assert.equal(attempt.calls.length, 2);
  assert.equal(attempt.calls[1].kind, "claude-code");
  assert.equal(decision.result.text, "from claude");
  assert.equal(decision.result.servedBy, "claude-code");
});

// ── scenario 3 (issue verify #2): send-time availability → fallback ───

test("issue #15: send-time availability error → fallback serves, reason 'rate-limit'", async () => {
  const view = makeView({ providerPreference: "openai-api", fallbackProviderPreference: "anthropic-api", anthropicApiKey: "sk-x" });
  const attempt = recordingAttempt([
    { ok: false, provider: {}, error: Object.assign(new Error("Too Many Requests"), { status: 429 }) },
    { ok: true, provider: {}, result: okResult("from anthropic") },
  ]);

  const decision = await view._runFailover("openai-api", attempt);

  assert.equal(decision.fellBack, true);
  assert.equal(decision.servedBy, "anthropic-api");
  assert.equal(decision.reason, "rate-limit");
});

// ── scenario 4 (issue verify #3): content error → NO failover ─────────

test("issue #15: genuine content error from a working provider does NOT fail over", async () => {
  const view = makeView({ providerPreference: "anthropic-api", fallbackProviderPreference: "claude-code", claudePath: "/usr/bin/claude" });
  const contentErr = new Error("model returned no parseable JSON");
  const attempt = recordingAttempt([{ ok: false, provider: {}, error: contentErr }]);

  await assert.rejects(
    () => view._runFailover("anthropic-api", attempt),
    (e) => e === contentErr,
    "the original content error must surface unchanged",
  );
  assert.equal(attempt.calls.length, 1, "no fallback attempt for content errors");
});

// ── scenario 5 (issue verify #4): no fallback configured ──────────────

test("issue #15: fallback 'none' + active send error → original error, single attempt", async () => {
  const view = makeView({ providerPreference: "anthropic-api", fallbackProviderPreference: "none" });
  const availErr = Object.assign(new Error("rate limited"), { status: 429 });
  const attempt = recordingAttempt([{ ok: false, provider: {}, error: availErr }]);

  await assert.rejects(() => view._runFailover("anthropic-api", attempt), (e) => e === availErr);
  assert.equal(attempt.calls.length, 1);
});

test("issue #15: no fallback + construct-null active → outcome 'unavailable' (no throw)", async () => {
  // sendMessage renders explainUnavailable() on this outcome.
  const view = makeView({ providerPreference: "anthropic-api", fallbackProviderPreference: "none" });
  const attempt = recordingAttempt([{ ok: false, provider: null, error: null }]);

  const decision = await view._runFailover("anthropic-api", attempt);
  assert.equal(decision.outcome, "unavailable");
  assert.equal(decision.result, null);
  assert.equal(attempt.calls.length, 1);
});

// ── same-kind guard: fallback resolves to the (dead) active kind ──────

test("issue #15: same-kind fallback is skipped (no pointless retry of the dead provider)", async () => {
  const view = makeView({ providerPreference: "anthropic-api", fallbackProviderPreference: "anthropic-api" });
  const availErr = Object.assign(new Error("rate limited"), { status: 429 });
  const attempt = recordingAttempt([{ ok: false, provider: {}, error: availErr }]);

  await assert.rejects(() => view._runFailover("anthropic-api", attempt), (e) => e === availErr);
  assert.equal(attempt.calls.length, 1, "must NOT retry the same provider kind");
});

// ── combined error: fallback also fails ───────────────────────────────

test("issue #15: fallback also fails → one combined, actionable error (no third hop)", async () => {
  const view = makeView({ providerPreference: "openai-api", fallbackProviderPreference: "anthropic-api", anthropicApiKey: "sk-x" });
  const attempt = recordingAttempt([
    { ok: false, provider: {}, error: Object.assign(new Error("Too Many Requests"), { status: 429 }) },
    { ok: false, provider: {}, error: new Error("anthropic 500 boom") },
  ]);

  await assert.rejects(
    () => view._runFailover("openai-api", attempt),
    (e) => {
      const m = String(e.message || e);
      return /openai-api/.test(m) && /rate-limit/.test(m) && /anthropic-api/.test(m) && /anthropic 500 boom/.test(m);
    },
    "combined error names both providers + the reason + the fallback's failure",
  );
  assert.equal(attempt.calls.length, 2, "exactly one fallback hop, no third attempt");
});

// ── issue #16: humanized fallback attribution message ─────────────────
//
// #15 already emits a system message on fellBack, but it printed raw kind
// ids ("google-api", "claude-code") and a raw reason ("no-api-key"). #16
// humanizes it via the provider-runtime kernel to the issue's exact shape.

test("issue #16: fellBack decision → humanized attribution message", () => {
  const view = makeView({});
  const decision = {
    outcome: "served",
    requestedProvider: "google-api",
    servedBy: "claude-code",
    fellBack: true,
    reason: "no-api-key",
  };
  assert.equal(
    view._formatFallbackNotice(decision),
    "Selected: Google Gemini API (unavailable: no API key) · Answered by: Claude Code CLI",
  );
});

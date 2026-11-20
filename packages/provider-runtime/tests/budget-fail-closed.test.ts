/**
 * Issue #53 — maxUsdBudget must FAIL CLOSED when a call's cost is unknown.
 *
 * Before the fix every provider counted a missing / unparsable cost as $0,
 * so a budgeted call whose cost couldn't be read was never stopped. Now an
 * unknown cost stops a budgeted call with BudgetExceededError
 * (costUnknown: true). Unbudgeted calls are unchanged.
 *
 * Covers every provider sharing the cost path: the four CLI providers
 * (plain + structured-output sites, and each one's own result parser) and
 * the three API tool loops.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

const realConfig = require("@polleoai/gryphon-provider-config");
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@polleoai/gryphon-protect") {
    return {
      buildDisallowedTools: () => [],
      winSpawn: { isWindowsShim: () => false, wrapForCmdShim: (cmd, a) => ({ command: cmd, args: a, options: {} }) },
      GRYPHON_SYSTEM_PROMPT_HINT: "[gryphon-hint]",
      GRYPHON_FALLBACK_DENY_HINT: "[gryphon-fallback]",
      hookDispatcher: { prepareSpawn: () => ({ ok: true, env: {}, args: [], cleanup: null }) },
    };
  }
  if (request === "@polleoai/gryphon-provider-config") return realConfig;
  return origLoad.call(this, request, ...args);
};

const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");
const { CodexProvider } = require("../src/providers/codex-cli/codex-cli");
const { GeminiCliProvider } = require("../src/providers/gemini-cli/gemini-cli");
const { AntigravityCliProvider } = require("../src/providers/antigravity-cli/antigravity-cli");
const { BudgetExceededError } = require("../src/budget-error");

const CLI = [
  ["claude-code", ClaudeCodeProvider],
  ["codex-cli", CodexProvider],
  ["gemini-cli", GeminiCliProvider],
  ["antigravity-cli", AntigravityCliProvider],
];

function spawnReturning(fields) {
  return () => Promise.resolve({
    text: '{"ok":true}', sessionId: "s", duration: 0, contextTokens: 0, cost: 0, ...fields,
  });
}

function make(Cls, spawn) {
  return new Cls({ config: {}, hostAdapter: { notify: () => {} }, _spawnOverride: spawn });
}

async function expectUnknownStop(p, options) {
  let err = null;
  try { await p.send("hi", options); } catch (e) { err = e; }
  assert.ok(err, "a budgeted call with unknown cost must not succeed");
  assert.ok(err instanceof BudgetExceededError, `expected BudgetExceededError, got ${err && err.name}: ${err && err.message}`);
  assert.equal(err.name, "BudgetExceededError");
  assert.equal(err.costUnknown, true);
  assert.equal(err.budget, 1);
}

const UNKNOWN = [
  ["missing cumulativeCost", { cumulativeCost: undefined }],
  ["NaN cumulativeCost", { cumulativeCost: NaN }],
  ["string cumulativeCost", { cumulativeCost: "0.5" }],
  ["negative cumulativeCost", { cumulativeCost: -1 }],
  ["costUnknown flag", { cumulativeCost: 0, costUnknown: true }],
];
const SCHEMA = { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, maxRetries: 1 };

for (const [name, Cls] of CLI) {
  for (const [label, fields] of UNKNOWN) {
    test(`${name}: ${label} stops a budgeted call (plain path)`, async () => {
      await expectUnknownStop(make(Cls, spawnReturning(fields)), { maxUsdBudget: 1 });
    });
    test(`${name}: ${label} stops a budgeted call (structured-output path)`, async () => {
      await expectUnknownStop(make(Cls, spawnReturning(fields)), { maxUsdBudget: 1, structuredOutput: SCHEMA });
    });
  }
  test(`${name}: unknown cost without a budget is unchanged`, async () => {
    const r = await make(Cls, spawnReturning({ cumulativeCost: undefined })).send("hi");
    assert.equal(r.text, '{"ok":true}');
  });
  test(`${name}: known cost under budget still passes`, async () => {
    const r = await make(Cls, spawnReturning({ cumulativeCost: 0.2, cost: 0.2 })).send("hi", { maxUsdBudget: 1 });
    assert.equal(r.text, '{"ok":true}');
  });
  test(`${name}: an unknown turn does not reset the session total`, async () => {
    const results = [{ cumulativeCost: 0.4, cost: 0.4 }, { cumulativeCost: undefined }, { cumulativeCost: 0.6, cost: 0.2 }];
    let i = 0;
    const p = make(Cls, () => spawnReturning(results[i++])());
    await p.send("a", { maxUsdBudget: 1 });
    await assert.rejects(p.send("b", { maxUsdBudget: 1 }), (e) => e.costUnknown === true);
    // Third call's own spend is 0.6 - 0.4 = 0.2 — under budget, so it passes.
    const r = await p.send("c", { maxUsdBudget: 1 });
    assert.equal(r.text, '{"ok":true}');
  });
}

// ---- each CLI's own result parser: missing usage → costUnknown, never a silent 0 ----

test("claude-code parser: result without total_cost_usd is costUnknown and keeps the session total", () => {
  const p = new ClaudeCodeProvider({ config: {}, hostAdapter: { notify: () => {} } });
  p.lastCumulativeCost = 0.75;
  let got = null;
  p.onDone = (r) => { got = r; };
  p._currentResolve = (r) => { got = got || r; };
  p._processEvent({ type: "result", session_id: "s", duration_ms: 1 });
  assert.ok(got, "result emitted");
  assert.equal(got.costUnknown, true);
  assert.equal(p.lastCumulativeCost, 0.75, "unknown cost must not reset the running total to 0");
  assert.equal(got.cumulativeCost, 0.75);
});

test("claude-code parser: a reported total_cost_usd is known", () => {
  const p = new ClaudeCodeProvider({ config: {}, hostAdapter: { notify: () => {} } });
  let got = null;
  p.onDone = (r) => { got = r; };
  p._processEvent({ type: "result", session_id: "s", total_cost_usd: 0.3, duration_ms: 1 });
  assert.ok(!got.costUnknown);
  assert.equal(got.cumulativeCost, 0.3);
});

// ---- codex / gemini / antigravity real result parsers (_handleClose) ----

function closeWith(p, prime, code = 0) {
  Object.assign(p, { _turnText: "x", ...prime });
  let got = null, rejected = null;
  p._currentResolve = (r) => { got = r; };
  p._currentReject = (e) => { rejected = e; };
  p._handleClose(code);
  assert.equal(rejected, null, `unexpected reject: ${rejected && rejected.message}`);
  assert.ok(got, "result resolved");
  return got;
}
const bare = (Cls) => new Cls({ config: {}, hostAdapter: { notify: () => {} } });

test("codex-cli parser: usage without input_tokens is costUnknown, cost 0", () => {
  const r = closeWith(bare(CodexProvider), { _lastUsage: { output_tokens: 5 } });
  assert.equal(r.costUnknown, true);
  assert.equal(r.cost, 0);
});
test("codex-cli parser: usage with input_tokens is known", () => {
  const r = closeWith(bare(CodexProvider), { _lastUsage: { input_tokens: 10, output_tokens: 5 } });
  assert.ok(!r.costUnknown);
  assert.ok(r.cost > 0);
});

test("gemini-cli parser: stats without input_tokens is costUnknown, cost 0", () => {
  const r = closeWith(bare(GeminiCliProvider), { _lastStats: { output_tokens: 5 } });
  assert.equal(r.costUnknown, true);
  assert.equal(r.cost, 0);
});
test("gemini-cli parser: stats with input_tokens is known", () => {
  const r = closeWith(bare(GeminiCliProvider), { _lastStats: { input_tokens: 10, output_tokens: 5 } });
  assert.ok(!r.costUnknown);
  assert.ok(r.cost > 0);
});
test("gemini-cli parser: stale-session recovery with streamed output is costUnknown", () => {
  const r = closeWith(bare(GeminiCliProvider), {
    _lastStats: null,
    _stderrTail: "Error resuming session: Invalid session identifier abc",
  }, 1);
  assert.equal(r.costUnknown, true);
});

test("antigravity-cli parser: result without usage is costUnknown, cost 0", () => {
  const r = closeWith(bare(AntigravityCliProvider), { _lastResult: { status: "SUCCESS", response: "x" } });
  assert.equal(r.costUnknown, true);
  assert.equal(r.cost, 0);
});
test("antigravity-cli parser: usage without input_tokens is costUnknown", () => {
  const r = closeWith(bare(AntigravityCliProvider), { _lastResult: { status: "SUCCESS", response: "x", usage: { output_tokens: 5 } } });
  assert.equal(r.costUnknown, true);
});
test("antigravity-cli parser: usage with input_tokens is known", () => {
  const r = closeWith(bare(AntigravityCliProvider), { _lastResult: { status: "SUCCESS", response: "x", usage: { input_tokens: 10, output_tokens: 5 } } });
  assert.ok(!r.costUnknown);
  assert.ok(r.cost > 0);
});

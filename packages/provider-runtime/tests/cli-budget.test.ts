/**
 * Task 4.5 — CLI providers enforce maxUsdBudget post-turn.
 *
 * CLI enforcement is post-turn: the subprocess owns its internal loop.
 * We can only check after the spawn returns. These tests assert that
 * BudgetExceededError is thrown when cumulativeCost >= maxUsdBudget.
 *
 * Uses _spawnOverride to inject a fake spawn that returns a high cost.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Stub obsidian + @gryphon/protect + @gryphon/provider-config before
// requiring any provider so the modules load without Obsidian infra.
const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@gryphon/protect") {
    return {
      buildDisallowedTools: () => [],
      winSpawn: { isWindowsShim: () => false, wrapForCmdShim: (cmd, a) => ({ command: cmd, args: a, options: {} }) },
      GRYPHON_SYSTEM_PROMPT_HINT: "[gryphon-hint]",
      GRYPHON_FALLBACK_DENY_HINT: "[gryphon-fallback]",
      hookDispatcher: {
        prepareSpawn: () => ({ ok: true, env: {}, args: [], cleanup: null }),
      },
    };
  }
  if (request === "@gryphon/provider-config") {
    return {
      filterExtraArgs: (a) => ({ filtered: a, dropped: [] }),
      pricing: {
        openai: {
          computeCost: () => ({ cost: 0 }),
          coerceToVendorModel: (m) => m || "gpt-5.4-mini",
          coerceToCodexCliModel: (m) => m || "gpt-5.5",
          DEFAULT_MODEL: "gpt-5.4-mini",
          CODEX_CLI_DEFAULT_MODEL: "gpt-5.5",
          resolveModel: (m) => m || "gpt-5.4-mini",
        },
        google: {
          computeCost: () => ({ cost: 0 }),
          coerceToVendorModel: (m) => m || "gemini-2.5-flash",
          DEFAULT_MODEL: "gemini-2.5-flash",
          resolveModel: (m) => m || "gemini-2.5-flash",
        },
      },
    };
  }
  return origLoad.call(this, request, ...args);
};

const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");
const { CodexProvider } = require("../src/providers/codex-cli/codex-cli");
const { GeminiCliProvider } = require("../src/providers/gemini-cli/gemini-cli");
const { BudgetExceededError } = require("../src/budget-error");

// A fake spawn that returns a result with cost exceeding the budget.
function makeHighCostSpawn(cumulativeCost) {
  return (_prompt) => Promise.resolve({
    text: "some response",
    cost: cumulativeCost,
    cumulativeCost,
    sessionId: "fake-session",
    duration: 0,
    contextTokens: 0,
  });
}

// A fake spawn that returns a cheap result.
function makeCheapSpawn() {
  return (_prompt) => Promise.resolve({
    text: "cheap response",
    cost: 0.01,
    cumulativeCost: 0.01,
    sessionId: "fake-session",
    duration: 0,
    contextTokens: 0,
  });
}

// ---------- claude-code ----------

test("claude-code: throws BudgetExceededError post-turn when cumulativeCost >= maxUsdBudget", async () => {
  const provider = new ClaudeCodeProvider({
    config: {},
    hostAdapter: { notify: () => {} },
    _spawnOverride: makeHighCostSpawn(1.50), // $1.50 > $1.00 budget
  });

  let caughtError = null;
  try {
    await provider.send("hi", { maxUsdBudget: 1.00 });
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError !== null, "should have thrown");
  assert.equal(caughtError.name, "BudgetExceededError");
  assert.ok(caughtError instanceof BudgetExceededError);
  assert.equal(caughtError.budget, 1.00);
  assert.ok(caughtError.spent >= 1.00, `spent=${caughtError.spent} should be >= 1.00`);
});

test("claude-code: no throw when cumulativeCost < maxUsdBudget", async () => {
  const provider = new ClaudeCodeProvider({
    config: {},
    hostAdapter: { notify: () => {} },
    _spawnOverride: makeCheapSpawn(),
  });

  const result = await provider.send("hi", { maxUsdBudget: 1.00 });
  assert.equal(result.text, "cheap response");
});

test("claude-code: no maxUsdBudget → plain passthrough", async () => {
  const provider = new ClaudeCodeProvider({
    config: {},
    hostAdapter: { notify: () => {} },
    _spawnOverride: makeHighCostSpawn(99.00),
  });

  // No maxUsdBudget option — must NOT throw even with very high cost.
  const result = await provider.send("hi");
  assert.equal(result.text, "some response");
});

// ---------- codex-cli ----------

test("codex-cli: throws BudgetExceededError post-turn when cumulativeCost >= maxUsdBudget", async () => {
  const provider = new CodexProvider({
    config: {},
    hostAdapter: { notify: () => {} },
    _spawnOverride: makeHighCostSpawn(2.00), // $2.00 > $1.00 budget
  });

  let caughtError = null;
  try {
    await provider.send("hi", { maxUsdBudget: 1.00 });
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError !== null, "should have thrown");
  assert.equal(caughtError.name, "BudgetExceededError");
  assert.ok(caughtError instanceof BudgetExceededError);
  assert.equal(caughtError.budget, 1.00);
  assert.ok(caughtError.spent >= 1.00, `spent=${caughtError.spent} should be >= 1.00`);
});

test("codex-cli: no throw when cumulativeCost < maxUsdBudget", async () => {
  const provider = new CodexProvider({
    config: {},
    hostAdapter: { notify: () => {} },
    _spawnOverride: makeCheapSpawn(),
  });

  const result = await provider.send("hi", { maxUsdBudget: 1.00 });
  assert.equal(result.text, "cheap response");
});

// ---------- gemini-cli ----------

test("gemini-cli: throws BudgetExceededError post-turn when cumulativeCost >= maxUsdBudget", async () => {
  const provider = new GeminiCliProvider({
    config: {},
    hostAdapter: { notify: () => {} },
    _spawnOverride: makeHighCostSpawn(1.25), // $1.25 > $1.00 budget
  });

  let caughtError = null;
  try {
    await provider.send("hi", { maxUsdBudget: 1.00 });
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError !== null, "should have thrown");
  assert.equal(caughtError.name, "BudgetExceededError");
  assert.ok(caughtError instanceof BudgetExceededError);
  assert.equal(caughtError.budget, 1.00);
  assert.ok(caughtError.spent >= 1.00, `spent=${caughtError.spent} should be >= 1.00`);
});

test("gemini-cli: no throw when cumulativeCost < maxUsdBudget", async () => {
  const provider = new GeminiCliProvider({
    config: {},
    hostAdapter: { notify: () => {} },
    _spawnOverride: makeCheapSpawn(),
  });

  const result = await provider.send("hi", { maxUsdBudget: 1.00 });
  assert.equal(result.text, "cheap response");
});

// ---------- multi-send regression tests (per-call delta, not session-cumulative) ----------

test("claude-code: maxUsdBudget is per-call, not session-cumulative — multi-send works", async () => {
  let sessionCost = 0;
  const provider = new ClaudeCodeProvider({
    config: { model: "claude-sonnet-4-6" },
    hostAdapter: { notify: () => {}, fetch: async () => ({}) },
    _spawnOverride: () => {
      // Each turn adds $0.40 to the running session cost
      sessionCost += 0.40;
      return Promise.resolve({
        text: "ok",
        sessionId: "s",
        cost: 0.40,
        cumulativeCost: sessionCost,
        contextTokens: 0,
      });
    },
  });

  // Call 1: $0.40 spent this call, within $0.50 budget
  await provider.send("turn 1", { maxUsdBudget: 0.50 });
  // (no throw — first call's per-call cost is $0.40)

  // Call 2: $0.40 spent THIS call (session is now $0.80, but per-call cost is $0.40)
  // Should NOT throw — per-call cost is below budget even though session-cumulative is over.
  await provider.send("turn 2", { maxUsdBudget: 0.50 });
  // If the bug exists, this throws BudgetExceededError because session-cumulative ($0.80) > maxUsdBudget ($0.50).
});

test("claude-code: maxUsdBudget catches a single call that exceeds budget", async () => {
  const provider = new ClaudeCodeProvider({
    config: { model: "claude-sonnet-4-6" },
    hostAdapter: { notify: () => {}, fetch: async () => ({}) },
    _spawnOverride: () => Promise.resolve({
      text: "ok", sessionId: "s", cost: 0.75,
      cumulativeCost: 0.75, contextTokens: 0,
    }),
  });

  let err = null;
  try {
    await provider.send("expensive turn", { maxUsdBudget: 0.50 });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "should throw");
  assert.equal(err.name, "BudgetExceededError");
  assert.equal(err.spent, 0.75);          // per-call, not session
  assert.equal(err.budget, 0.50);
});

test("codex-cli: maxUsdBudget is per-call, not session-cumulative — multi-send works", async () => {
  let sessionCost = 0;
  const provider = new CodexProvider({
    config: { model: "gpt-5.5" },
    hostAdapter: { notify: () => {}, fetch: async () => ({}) },
    _spawnOverride: () => {
      sessionCost += 0.40;
      return Promise.resolve({
        text: "ok",
        sessionId: "s",
        cost: 0.40,
        cumulativeCost: sessionCost,
        contextTokens: 0,
      });
    },
  });

  // Call 1: $0.40 per-call, within $0.50 budget
  await provider.send("turn 1", { maxUsdBudget: 0.50 });

  // Call 2: $0.40 per-call (session $0.80) — should NOT throw
  await provider.send("turn 2", { maxUsdBudget: 0.50 });
});

test("codex-cli: maxUsdBudget catches a single call that exceeds budget", async () => {
  const provider = new CodexProvider({
    config: { model: "gpt-5.5" },
    hostAdapter: { notify: () => {}, fetch: async () => ({}) },
    _spawnOverride: () => Promise.resolve({
      text: "ok", sessionId: "s", cost: 0.75,
      cumulativeCost: 0.75, contextTokens: 0,
    }),
  });

  let err = null;
  try {
    await provider.send("expensive turn", { maxUsdBudget: 0.50 });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "should throw");
  assert.equal(err.name, "BudgetExceededError");
  assert.equal(err.spent, 0.75);
  assert.equal(err.budget, 0.50);
});

test("gemini-cli: maxUsdBudget is per-call, not session-cumulative — multi-send works", async () => {
  let sessionCost = 0;
  const provider = new GeminiCliProvider({
    config: { model: "gemini-2.5-flash" },
    hostAdapter: { notify: () => {}, fetch: async () => ({}) },
    _spawnOverride: () => {
      sessionCost += 0.40;
      return Promise.resolve({
        text: "ok",
        sessionId: "s",
        cost: 0.40,
        cumulativeCost: sessionCost,
        contextTokens: 0,
      });
    },
  });

  // Call 1: $0.40 per-call, within $0.50 budget
  await provider.send("turn 1", { maxUsdBudget: 0.50 });

  // Call 2: $0.40 per-call (session $0.80) — should NOT throw
  await provider.send("turn 2", { maxUsdBudget: 0.50 });
});

test("gemini-cli: maxUsdBudget catches a single call that exceeds budget", async () => {
  const provider = new GeminiCliProvider({
    config: { model: "gemini-2.5-flash" },
    hostAdapter: { notify: () => {}, fetch: async () => ({}) },
    _spawnOverride: () => Promise.resolve({
      text: "ok", sessionId: "s", cost: 0.75,
      cumulativeCost: 0.75, contextTokens: 0,
    }),
  });

  let err = null;
  try {
    await provider.send("expensive turn", { maxUsdBudget: 0.50 });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "should throw");
  assert.equal(err.name, "BudgetExceededError");
  assert.equal(err.spent, 0.75);
  assert.equal(err.budget, 0.50);
});

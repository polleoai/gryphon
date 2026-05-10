/**
 * Issue #30 regression: MAX_SDK_SEED_TURNS scales linearly with the
 * active model's context window.
 *
 *   200K window (sonnet/opus/haiku)      → cap 100 (existing behavior)
 *   1M window (opus[1m])                  → cap 500 (5× more turns)
 *   Unknown model id (OpenAI/Gemini ids)  → cap 100 (safe fallback)
 *
 * The cap can never DECREASE below 100 — the pre-fix baseline. Larger
 * windows can hold proportionally more conversation; smaller-than-200K
 * models still get the safe 100-turn floor.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { GryphonChatView } = require("../src/chat-view");

function makeStub({ model, turns }) {
  const fullHistory = [];
  // Build `turns` user/assistant pairs (so total entries = 2*turns).
  for (let i = 0; i < turns; i++) {
    fullHistory.push({ role: "user",      text: `u${i}`, source: "llm" });
    fullHistory.push({ role: "assistant", text: `a${i}`, source: "llm" });
  }
  const stub = {
    _fullHistory: fullHistory,
    plugin: { settings: { model } },
  };
  stub._extractLlmTurnsFromFullHistory =
    GryphonChatView.prototype._extractLlmTurnsFromFullHistory.bind(stub);
  return stub;
}

test("issue #30: 200K window models cap at 100 turns (baseline preserved)", () => {
  const stub = makeStub({ model: "sonnet", turns: 200 });
  const seed = stub._extractLlmTurnsFromFullHistory();
  // 200 user/assistant pairs = 400 entries; cap 100 keeps the LAST 100.
  assert.equal(seed.length, 100,
    "200K-window model must keep the existing 100-turn cap");
});

test("issue #30: 1M window models cap at 500 turns (linear scaling)", () => {
  const stub = makeStub({ model: "opus[1m]", turns: 600 });
  const seed = stub._extractLlmTurnsFromFullHistory();
  // 600 user/assistant pairs = 1200 entries; 1M window gives 5× cap.
  assert.equal(seed.length, 500,
    "opus[1m] (1M window) must scale the cap to 500 turns");
});

test("issue #30: unknown model id falls back to 100 (safe default)", () => {
  // OpenAI / Gemini model ids aren't in MODEL_CONTEXT yet — they must
  // get the conservative 100-turn cap, not an unbounded value.
  const stub = makeStub({ model: "gpt-4o", turns: 200 });
  const seed = stub._extractLlmTurnsFromFullHistory();
  assert.equal(seed.length, 100,
    "unknown model ids must use the safe 100-turn fallback");
});

test("issue #30: cap never drops below 100 even if model has tiny window", () => {
  // No model in MODEL_CONTEXT today has <200K, but if one were added,
  // the cap floor must hold so existing users don't see fewer turns
  // than v1.1.x preserved.
  const stub = makeStub({ model: undefined, turns: 150 });
  const seed = stub._extractLlmTurnsFromFullHistory();
  assert.equal(seed.length, 100,
    "missing model must still preserve the 100-turn floor");
});

test("issue #30: short conversations are unaffected (no truncation when below cap)", () => {
  const stub = makeStub({ model: "opus[1m]", turns: 10 });
  const seed = stub._extractLlmTurnsFromFullHistory();
  assert.equal(seed.length, 20,
    "10 turn-pairs = 20 entries, well below any cap — full seed forwards");
});

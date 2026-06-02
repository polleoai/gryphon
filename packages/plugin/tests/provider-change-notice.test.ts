/**
 * Issue #29 regression: changing Provider in Settings flashes a one-shot
 * status notice that names the new provider and the seed-history count.
 * Skipped on first-time setup (no prior llm turns to forward).
 *
 * The seed count must come from the same function that produces the
 * actual seed (`_extractLlmTurnsFromFullHistory`), so the user-visible
 * number can't drift from what's actually sent to the provider.
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

function makeStub(fullHistory) {
  const flashed = [];
  const stub = {
    _fullHistory: fullHistory,
    _flashStatus: (text, ms) => flashed.push({ text, ms }),
  };
  stub._extractLlmTurnsFromFullHistory =
    GryphonChatView.prototype._extractLlmTurnsFromFullHistory.bind(stub);
  stub._flashProviderChangeNotice =
    GryphonChatView.prototype._flashProviderChangeNotice.bind(stub);
  stub._flashed = flashed;
  return stub;
}

const llm = (role, text) => ({ role, text, source: "llm" });

test("issue #29: notice fires when prior conversation exists", () => {
  const stub = makeStub([
    llm("user", "hello"),
    llm("assistant", "hi"),
    llm("user", "follow-up"),
    llm("assistant", "answer"),
  ]);
  stub._flashProviderChangeNotice("anthropic-api", "google-api");
  assert.equal(stub._flashed.length, 1, "exactly one notice flash");
  const { text } = stub._flashed[0];
  assert.match(text, /Google Gemini API/,
    "notice must name the new provider in human-readable form");
  assert.match(text, /4 turns/,
    "notice must report the actual seed-turn count (4 here)");
  assert.match(text, /\/new/,
    "notice must surface the /new escape hatch");
});

test("issue #29: notice is skipped on first-time setup (no prior turns)", () => {
  const stub = makeStub([]);
  stub._flashProviderChangeNotice("anthropic-api", "openai-api");
  assert.equal(stub._flashed.length, 0,
    "first-time setup must NOT flash — there's nothing to forward");
});

test("issue #29: notice is skipped when only system messages exist", () => {
  const stub = makeStub([
    { role: "system", text: "welcome", source: "system" },
  ]);
  stub._flashProviderChangeNotice("anthropic-api", "openai-api");
  assert.equal(stub._flashed.length, 0,
    "system-only history yields zero seed turns; no notice required");
});

test("issue #29: brand label is short and clean (no parenthetical suffixes)", () => {
  const stub = makeStub([llm("user", "u"), llm("assistant", "a")]);
  stub._flashProviderChangeNotice("openai-api", "claude-code");
  const { text } = stub._flashed[0];
  assert.match(text, /Claude Code CLI/);
  assert.doesNotMatch(text, /\(recommended\)|\(advanced\)/,
    "PROVIDER_PREFS label suffixes must NOT leak into the status notice");
});

test("issue #29: each call flashes once (one-shot per change)", () => {
  const stub = makeStub([llm("user", "u"), llm("assistant", "a")]);
  stub._flashProviderChangeNotice("anthropic-api", "google-api");
  stub._flashProviderChangeNotice("google-api", "openai-api");
  assert.equal(stub._flashed.length, 2,
    "two distinct provider changes → two notices (one per change, not cumulative)");
});

test("issue #30 deferred: notice surfaces dropped-turn count when cap truncates", () => {
  // Build 250 turn-pairs (500 entries). Default cap (no model id)
  // is 100, so 200 pairs (400 entries) get dropped — assertion below
  // checks /older 400 turns dropped/. The user must see this in the
  // notice instead of having early context vanish silently.
  const fullHistory = [];
  for (let i = 0; i < 250; i++) {
    fullHistory.push(llm("user", `u${i}`));
    fullHistory.push(llm("assistant", `a${i}`));
  }
  const stub = makeStub(fullHistory);
  stub._flashProviderChangeNotice("anthropic-api", "google-api");
  assert.equal(stub._flashed.length, 1);
  const { text } = stub._flashed[0];
  // 100 cap → 100 entries kept (50 turn-pairs); the rest drop.
  assert.match(text, /older 400 turns dropped/i,
    "notice must report the count of dropped llm-source entries");
  assert.match(text, /Google Gemini API/);
  assert.match(text, /\/new to start fresh/);
});

test("issue #30 deferred: no drop suffix when conversation fits under cap", () => {
  const stub = makeStub([
    llm("user", "u1"), llm("assistant", "a1"),
    llm("user", "u2"), llm("assistant", "a2"),
  ]);
  stub._flashProviderChangeNotice("anthropic-api", "openai-api");
  const { text } = stub._flashed[0];
  assert.doesNotMatch(text, /dropped/i,
    "small conversations must not trigger the truncation suffix");
});

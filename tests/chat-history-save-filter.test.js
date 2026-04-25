/**
 * filterMessagesForSave — regression tests for the per-session save
 * filter that replaced the old "if hasCliSession, drop ALL LLM
 * messages" heuristic (commit c001059).
 *
 * The invariant being protected: LLM messages are suppressed from
 * chat-history.json ONLY when we're currently in a CLI session AND
 * the message was authored during that same session (it'll be
 * re-supplied by CC's jsonl on load). All other messages — non-LLM,
 * SDK-era LLM, prior CLI session LLM, legacy untagged — survive.
 *
 * Before the fix, a user who started a conversation in SDK and
 * switched to CLI would lose their SDK turns on the first CLI save.
 * This test file pins the current behavior so any future
 * "simplification" of the filter fails loudly.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Stub obsidian so chat-view.js can be required under node:test.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { filterMessagesForSave } = require("../src/chat-view");

function msg(role, source, text, sessionId) {
  return { role, source, text, sessionId, ts: new Date().toISOString() };
}

// ── Non-LLM messages always survive ──────────────────────────────

test("system messages survive regardless of session state", () => {
  const messages = [
    msg("system", "system", "Setting updated", null),
    msg("system", "system", "Error: X", "uuid-1"),
  ];
  const out = filterMessagesForSave(messages, "uuid-1");
  assert.equal(out.length, 2);
});

test("mechanical-source user messages survive", () => {
  const messages = [msg("user", "mechanical", "/compact", "uuid-1")];
  const out = filterMessagesForSave(messages, "uuid-1");
  assert.equal(out.length, 1);
});

test("messages without source are dropped (corrupt/untagged)", () => {
  const messages = [{ role: "user", text: "hello" }];
  const out = filterMessagesForSave(messages, "uuid-1");
  assert.equal(out.length, 0);
});

// ── Anthropic API mode: all LLM messages persist ──────────────────────────

test("Anthropic API mode (sdk- prefix): all LLM messages persist", () => {
  const messages = [
    msg("user", "llm", "hi", "sdk-123"),
    msg("assistant", "llm", "hello", "sdk-123"),
  ];
  const out = filterMessagesForSave(messages, "sdk-123");
  assert.equal(out.length, 2);
});

test("null sessionId: treated as Anthropic API mode, LLM messages persist", () => {
  // No session set yet (fresh install, no provider contact).
  const messages = [msg("user", "llm", "hi", null)];
  const out = filterMessagesForSave(messages, null);
  assert.equal(out.length, 1);
});

// ── Claude Code mode: drop only the CURRENT session's LLM messages ────────

test("Claude Code mode: drops LLM messages matching the current session ID", () => {
  const messages = [
    msg("user", "llm", "hi", "uuid-current"),
    msg("assistant", "llm", "hello", "uuid-current"),
  ];
  const out = filterMessagesForSave(messages, "uuid-current");
  assert.equal(out.length, 0, "current-session LLM messages are in CC's jsonl, no need to persist");
});

test("Claude Code mode: keeps SDK-era LLM messages (the c001059 regression case)", () => {
  const messages = [
    msg("user", "llm", "old SDK question", "sdk-456"),
    msg("assistant", "llm", "old SDK answer", "sdk-456"),
    msg("user", "llm", "new CLI question", "uuid-current"),
    msg("assistant", "llm", "new CLI answer", "uuid-current"),
  ];
  const out = filterMessagesForSave(messages, "uuid-current");
  // SDK-era stays (source 1 on reload — no jsonl for sdk-456 exists).
  // CLI-era dropped (CC's jsonl for uuid-current has them).
  assert.equal(out.length, 2);
  assert.ok(out.every((m) => m.sessionId === "sdk-456"));
});

test("Claude Code mode: keeps LLM messages from a prior CLI session", () => {
  const messages = [
    msg("user", "llm", "question before compact", "uuid-old"),
    msg("user", "llm", "question after compact", "uuid-new"),
  ];
  const out = filterMessagesForSave(messages, "uuid-new");
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, "uuid-old");
});

test("Claude Code mode: keeps legacy untagged LLM messages (sessionId undefined)", () => {
  // Pre-v0.9.2 users don't have sessionId in their saved data.
  // The filter must keep those — they're from sessions we don't know.
  const messages = [
    { role: "user", source: "llm", text: "old", ts: "2024-01-01T00:00:00Z" },  // no sessionId
    msg("user", "llm", "new", "uuid-current"),
  ];
  const out = filterMessagesForSave(messages, "uuid-current");
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "old");
});

test("Claude Code mode: keeps LLM message tagged null (tagged before session was established)", () => {
  // v0.9.2 retagging retroactively fixes this on turn completion.
  // But until retagging runs, a null-tagged LLM message should stay
  // — safer to duplicate once on reload than lose it forever.
  const messages = [msg("user", "llm", "fresh-install prompt", null)];
  const out = filterMessagesForSave(messages, "uuid-current");
  assert.equal(out.length, 1);
});

// ── Mixed scenarios ──────────────────────────────────────────────

test("Claude Code mode: system notices from current session are kept (not LLM)", () => {
  const messages = [
    msg("system", "system", "Setting updated", "uuid-current"),
    msg("assistant", "llm", "model reply", "uuid-current"),
  ];
  const out = filterMessagesForSave(messages, "uuid-current");
  // System message kept, LLM message dropped.
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "system");
});

test("handles null/undefined input safely", () => {
  assert.deepEqual(filterMessagesForSave(null, "uuid"), []);
  assert.deepEqual(filterMessagesForSave(undefined, "uuid"), []);
  assert.deepEqual(filterMessagesForSave([], "uuid"), []);
});

test("empty-string sessionId treated as null (not a real CLI session)", () => {
  const messages = [msg("user", "llm", "hi", "")];
  const out = filterMessagesForSave(messages, "");
  // currentIsCli false (empty string → null), so LLM persists.
  assert.equal(out.length, 1);
});

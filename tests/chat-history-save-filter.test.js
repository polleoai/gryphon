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

// ── Bug #23 regression: failed-send messages must survive ─────────

test("Bug #23 — failed-send user message tagged sessionId=null survives even when current is a CLI session", () => {
  // Scenario: user previously ran a Claude Code session (lastSessionId
  // is a CLI uuid). They switch Provider to openai-api (no key) and
  // type "hello". The send fails because createProvider returned null.
  // The chat-view code path explicitly sets sessionId=null on the
  // user message before saving, so filterMessagesForSave must KEEP it
  // even though current is a CLI session.
  const messages = [
    msg("user", "llm", "hello", null), // failed-send: explicitly cleared sessionId
  ];
  const out = filterMessagesForSave(messages, "uuid-cli-stale");
  assert.equal(out.length, 1, "failed-send user message must persist across save");
  assert.equal(out[0].text, "hello");
});

test("Bug #23 — failed-send error bubble (mechanical) survives any session state", () => {
  // The error bubble emitted by _cleanupStreamingState → finalizeStreamingMessage
  // has source="mechanical" (default), which was already covered by the
  // existing filter contract. This test pins that the bubble survives
  // even when the user message that preceded it was tagged with the
  // current CLI sessionId (regression-safety: the two messages together
  // form the recovery context the user needs).
  const messages = [
    msg("user", "llm", "hello", null),
    msg("assistant", "mechanical", "OpenAI API key not set. Paste a key in Settings → Gryphon → OpenAI API key.", "uuid-cli-stale"),
  ];
  const out = filterMessagesForSave(messages, "uuid-cli-stale");
  assert.equal(out.length, 2, "both failed-send messages survive together");
});

test("Bug #23 — pre-fix scenario: user message with stale CLI sessionId IS dropped (regression marker)", () => {
  // This test pins the BEHAVIOR THAT EXISTED BEFORE THE FIX — if a
  // future refactor removes the explicit `lastUserMsg.sessionId = null`
  // assignment in the failed-send branch of sendMessage, the user
  // message would inherit lastSessionId, match currentSessionId, and
  // be dropped. This test makes that breakage detectable: it's the
  // behavior we're working AROUND, not endorsing. If the chat-view
  // code path is correct, no message should EVER hit this branch with
  // matching sessionIds in a failed-send scenario.
  const messages = [msg("user", "llm", "hello", "uuid-cli-stale")];
  const out = filterMessagesForSave(messages, "uuid-cli-stale");
  assert.equal(out.length, 0, "pre-fix behavior: stale-CLI-tagged llm message is dropped (this is what Bug #23's fix routes around in chat-view.js)");
});

// ---------- Bug #24 fix: SDK session detection across all three providers ----------
//
// Before the fix, filterMessagesForSave only recognized the legacy
// anthropic-api "sdk-" prefix. OpenAI ("openai-sdk-...") and Gemini
// ("gemini-sdk-...") sessions were misclassified as CLI sessions, so
// the filter dropped llm messages tagged with the current SDK sessionId
// — silent user data loss across every Stage 2 / Stage 3 turn whose
// save happened to fire with a matching lastSessionId.

test("Bug #24 — anthropic-api SDK session: llm messages tagged with current sessionId are KEPT (no CLI re-supply)", () => {
  const messages = [
    msg("user", "llm", "what is 2+2?", "sdk-12345"),
    msg("assistant", "llm", "4", "sdk-12345"),
  ];
  const out = filterMessagesForSave(messages, "sdk-12345");
  assert.equal(out.length, 2, "anthropic-api SDK turns must survive (no CLI jsonl to re-supply)");
});

test("Bug #24 — openai-api SDK session: llm messages tagged with current sessionId are KEPT", () => {
  const messages = [
    msg("user", "llm", "summarize this page", "openai-sdk-1777755129921"),
    msg("assistant", "llm", "this page describes...", "openai-sdk-1777755129921"),
  ];
  const out = filterMessagesForSave(messages, "openai-sdk-1777755129921");
  assert.equal(out.length, 2,
    "OpenAI SDK turns must survive — would have been dropped before the #24 fix because the broken legacy " +
    "startsWith('sdk-') check classified 'openai-sdk-' as CLI");
});

test("Bug #24 — google-api SDK session: llm messages tagged with current sessionId are KEPT (the user-reported wild bug)", () => {
  // This is the exact scenario the user reported on 2026-05-02:
  // "i asked gryphon summized the page before this test. but that
  // dialogue is missing. it should be right after hello."
  // The user's "summarize this page" turn was tagged with
  // gemini-sdk-... matching lastSessionId, and the broken filter
  // dropped both halves of the turn from chat-history.json.
  const messages = [
    msg("user", "llm", "hello", "gemini-sdk-OLD-id"),
    msg("assistant", "llm", "Hello! How can I help?", "gemini-sdk-OLD-id"),
    msg("user", "llm", "summarize this page", "gemini-sdk-1777772425263"),
    msg("assistant", "llm", "The page describes...", "gemini-sdk-1777772425263"),
  ];
  // Save fires with currentSessionId matching the latest turn — the wild
  // bug condition that was eating the user's data.
  const out = filterMessagesForSave(messages, "gemini-sdk-1777772425263");
  assert.equal(out.length, 4,
    "Gemini SDK turns must ALL survive. Before the fix, the latest turn was dropped silently.");
  assert.match(out[2].text, /summarize/);
  assert.match(out[3].text, /describes/);
});

test("Bug #24 — CLI session (UUID): the existing 'drop current CLI session messages' optimization still applies", () => {
  // This test pins the established behavior that the fix preserves: for
  // genuine CLI sessions (UUID-shaped sessionIds), llm messages tagged
  // with the current CLI sessionId still get dropped — Claude Code's
  // jsonl re-supplies them on resume so we don't need to persist them.
  const messages = [
    msg("user", "llm", "hello", "d7f8906d-0bca-4003-b319-292de5a5d4f0"),
    msg("assistant", "llm", "hi", "d7f8906d-0bca-4003-b319-292de5a5d4f0"),
  ];
  const out = filterMessagesForSave(messages, "d7f8906d-0bca-4003-b319-292de5a5d4f0");
  assert.equal(out.length, 0, "CLI optimization preserved: messages tagged with current CLI session are dropped");
});

test("Bug #24 — mixed SDK + CLI history: SDK tags survive even when current is CLI", () => {
  // Realistic scenario: user has prior SDK turns in history, currently
  // on CLI mode. The current-CLI optimization must NOT touch the SDK
  // turns (they're not in CLI's jsonl).
  const messages = [
    msg("user", "llm", "openai turn", "openai-sdk-aaa"),
    msg("assistant", "llm", "openai response", "openai-sdk-aaa"),
    msg("user", "llm", "gemini turn", "gemini-sdk-bbb"),
    msg("assistant", "llm", "gemini response", "gemini-sdk-bbb"),
    msg("user", "llm", "current cli", "uuid-current-cli"),
    msg("assistant", "llm", "cli response", "uuid-current-cli"),
  ];
  const out = filterMessagesForSave(messages, "uuid-current-cli");
  // Only the current-CLI pair (last 2) should be dropped.
  assert.equal(out.length, 4);
  assert.match(out[0].text, /openai/);
  assert.match(out[2].text, /gemini turn/);
});

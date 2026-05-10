/**
 * Issue #36 regression: aborted/errored user prompts must survive the
 * save filter so up-arrow recall finds them after Obsidian reload.
 *
 * Pre-fix: filterMessagesForSave dropped any source="llm" message
 * whose sessionId matched the current CLI session, on the assumption
 * that CC's jsonl had a copy. Aborted prompts that the CLI never
 * received broke that assumption — they vanished from chat-history.json
 * with no jsonl backup, so up-arrow lost them on reload.
 *
 * Post-fix: a `failed: true` flag exempts the message from the
 * session-match drop. The flag is set in _markLastUserPromptFailed,
 * which fires from _cleanupStreamingState (every abort/timeout path)
 * and from sendMessage's catch (every send rejection).
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

const { GryphonChatView, filterMessagesForSave } = require("../src/chat-view");

const llm = (role, text, sessionId, opts = {}) => ({
  role,
  text,
  source: "llm",
  sessionId: sessionId || null,
  ts: opts.ts || "2026-04-01T00:00:00Z",
  ...opts,
});

// ── filterMessagesForSave: failed flag exempts session-match drop ────

test("issue #36: CLI aborted prompt (failed=true) survives session-match drop", () => {
  const messages = [
    llm("user", "successful prompt", "cli-session-A"),
    llm("assistant", "successful response", "cli-session-A"),
    llm("user", "aborted prompt", "cli-session-A", { failed: true }),
  ];
  const filtered = filterMessagesForSave(messages, "cli-session-A");
  // Pre-fix: all three would be dropped (CLI session match → save
  // assumes jsonl has them). Post-fix: failed:true exempts the
  // aborted prompt so it persists to chat-history.json.
  const aborted = filtered.find((m) => m.text === "aborted prompt");
  assert.ok(aborted, "aborted prompt must survive the save filter");
  assert.equal(aborted.failed, true, "the failed flag must be preserved on disk");
});

test("issue #36: non-failed CLI prompts still drop on session match (no regression)", () => {
  const messages = [
    llm("user", "successful prompt", "cli-session-A"),
    llm("assistant", "successful response", "cli-session-A"),
  ];
  const filtered = filterMessagesForSave(messages, "cli-session-A");
  assert.equal(filtered.length, 0,
    "successful CLI prompts still drop (CC's jsonl has them) — only failed:true is the exception");
});

test("issue #36: failed prompts from a DIFFERENT session also survive", () => {
  // Defensive: even though the session-match drop wouldn't fire here,
  // the flag must propagate through.
  const messages = [
    llm("user", "old aborted", "old-session", { failed: true }),
    llm("user", "current ok", "cli-session-A"),
  ];
  const filtered = filterMessagesForSave(messages, "cli-session-A");
  const aborted = filtered.find((m) => m.text === "old aborted");
  assert.ok(aborted, "different-session failed prompt must persist too");
  assert.equal(aborted.failed, true);
});

test("issue #36: SDK mode preserves all llm messages (failed flag is harmless)", () => {
  const messages = [
    llm("user", "u1", "sdk-anthropic-1", { failed: true }),
    llm("assistant", "a1", "sdk-anthropic-1"),
  ];
  const filtered = filterMessagesForSave(messages, "sdk-anthropic-1");
  assert.equal(filtered.length, 2,
    "SDK sessions never drop llm messages; failed flag changes nothing here");
});

// ── _markLastUserPromptFailed walks back to the right entry ──────────

test("issue #36: _markLastUserPromptFailed flags only the LAST llm-user message", () => {
  const view = {
    messages: [
      llm("user", "first user", "s"),
      llm("assistant", "first reply", "s"),
      llm("user", "second user", "s"),
      llm("assistant", "second reply", "s"),
      // System message added after the last user prompt — the helper
      // must scan past it to find the user entry, not flag the system.
      { role: "system", source: "system", text: "Error: ...", ts: "x" },
    ],
  };
  view._markLastUserPromptFailed =
    GryphonChatView.prototype._markLastUserPromptFailed.bind(view);
  view._markLastUserPromptFailed();

  assert.equal(view.messages[2].failed, true,
    "the most recent llm user prompt must be flagged");
  assert.equal(view.messages[0].failed, undefined,
    "earlier user prompts must be untouched");
  assert.equal(view.messages[3].failed, undefined,
    "assistant messages must never be flagged");
  assert.equal(view.messages[4].failed, undefined,
    "system messages must never be flagged");
});

test("issue #36: _markLastUserPromptFailed is idempotent — already-flagged user prompt is left alone", () => {
  const view = {
    messages: [
      llm("user", "older user", "s"),
      llm("user", "recent user", "s", { failed: true }),
    ],
  };
  view._markLastUserPromptFailed =
    GryphonChatView.prototype._markLastUserPromptFailed.bind(view);
  view._markLastUserPromptFailed();

  // The recent prompt was already failed; the helper must NOT walk
  // past it and accidentally flag the older one.
  assert.equal(view.messages[1].failed, true);
  assert.equal(view.messages[0].failed, undefined,
    "must skip already-failed entries; do not flag the older user prompt as a side effect");
});

test("issue #36: _markLastUserPromptFailed is a no-op when no user llm messages exist", () => {
  const view = {
    messages: [
      { role: "system", source: "system", text: "welcome", ts: "x" },
    ],
  };
  view._markLastUserPromptFailed =
    GryphonChatView.prototype._markLastUserPromptFailed.bind(view);
  // Must not throw.
  view._markLastUserPromptFailed();
  assert.equal(view.messages[0].failed, undefined);
});

test("issue #36: _markLastUserPromptFailed bounded scan (does not walk arbitrarily far)", () => {
  // 50 system messages in front of the user prompt → outside the
  // 10-entry bounded scan. The helper must NOT find it (bounded for
  // O(1) cost). User prompt remains unflagged.
  const messages = [llm("user", "buried user", "s")];
  for (let i = 0; i < 50; i++) {
    messages.push({ role: "system", source: "system", text: `s${i}`, ts: "x" });
  }
  const view = { messages };
  view._markLastUserPromptFailed =
    GryphonChatView.prototype._markLastUserPromptFailed.bind(view);
  view._markLastUserPromptFailed();

  assert.equal(messages[0].failed, undefined,
    "bounded scan must not reach back 50 entries (perf guarantee for long sessions)");
});

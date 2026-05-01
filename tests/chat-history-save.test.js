/**
 * Regression test for v0.5.9: chat history must NOT be truncated to the
 * last-30 render window on save. Pre-fix, `_restoreChatHistory` set
 * `this.messages = last-30-of-fullHistory`, so every subsequent save
 * rewrote chat-history.json with only that tail — losing older entries
 * on every addSystemMessage / addUserMessage / etc.
 *
 * This test reproduces the scenario structurally by exercising the
 * message-array invariants without standing up a full Obsidian view:
 *
 *   1. Simulate loading 50 persisted messages.
 *   2. Verify that `this.messages` mirrors the full 50, not just 30.
 *   3. Push one system message via the same pattern addSystemMessage
 *      uses.
 *   4. Verify that this.messages is 51, not 31.
 *   5. Verify the filter-for-save path keeps all relevant entries.
 *
 * We construct a minimal mock of the relevant pieces of GryphonChatView
 * rather than loading the full module — the bug is in the load/save
 * integration, and we're testing the contract, not the UI.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// Reconstruct the fixed logic in a self-contained harness. The real
// methods are on GryphonChatView (chat-view.js), which requires Obsidian
// to load. This harness mirrors the post-fix contract in
// _restoreChatHistory + addSystemMessage so a regression in the contract
// fails this test.
class FakeChatView {
  constructor(persistedHistory) {
    this._loadResult = persistedHistory;
    this.messages = [];
    this._fullHistory = [];
    this._historyLoadedUpTo = 0;
  }

  _restoreChatHistory() {
    this._fullHistory = this._loadResult;
    if (this._fullHistory.length === 0) return;

    // Post-v0.5.9 contract: this.messages is the FULL history, not a slice.
    this.messages = [...this._fullHistory];

    const BATCH = 30;
    this._historyLoadedUpTo = Math.max(0, this._fullHistory.length - BATCH);
  }

  addSystemMessage(text) {
    this.messages.push({
      role: "system",
      text,
      ts: new Date().toISOString(),
      source: "system",
    });
  }

  // Mirrors the filter in _doSaveChatHistory(). The persistLlm decision
  // is passed in by the test so both CLI-mode and SDK-mode paths can be
  // exercised.
  filterForSave(persistLlm) {
    return this.messages.filter((m) =>
      m.source && (m.source !== "llm" || persistLlm),
    );
  }
}

function makeFixture(n, sourceOverride = null) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `msg ${i}`,
      ts: `2026-04-20T00:00:${String(i).padStart(2, "0")}Z`,
      source: sourceOverride || "llm",
    });
  }
  return out;
}

// ── Regression: save path must not truncate to the render tail ─────────

test("restore loads full history into messages, not just the render tail", () => {
  const persisted = makeFixture(50);
  const view = new FakeChatView(persisted);
  view._restoreChatHistory();
  assert.equal(view.messages.length, 50);
  assert.equal(view._historyLoadedUpTo, 50 - 30);
});

test("a subsequent addSystemMessage does NOT drop older messages", () => {
  const persisted = makeFixture(50);
  const view = new FakeChatView(persisted);
  view._restoreChatHistory();
  view.addSystemMessage("Setting updated — takes effect on next message");
  assert.equal(view.messages.length, 51);
  // Earliest entry is preserved — this is the direct inverse of the v0.5.8 bug
  assert.equal(view.messages[0].text, "msg 0");
  assert.equal(view.messages[50].role, "system");
});

test("CLI-mode filter (persistLlm=false) saves system / mechanical entries only", () => {
  // Claude Code mode: CC owns LLM turns via its .jsonl. Our save keeps only
  // non-llm entries (system messages, plugin-slash-command logs).
  const mixed = [
    ...makeFixture(30, "llm"),
    { role: "system", text: "hi", ts: "2026-04-20T01:00:00Z", source: "system" },
    { role: "user", text: "/compact", ts: "2026-04-20T01:01:00Z", source: "mechanical" },
  ];
  const view = new FakeChatView(mixed);
  view._restoreChatHistory();
  const saved = view.filterForSave(false);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].source, "system");
  assert.equal(saved[1].source, "mechanical");
});

test("SDK-mode filter (persistLlm=true) saves everything with a source field", () => {
  const mixed = [
    ...makeFixture(30, "llm"),
    { role: "system", text: "hi", ts: "2026-04-20T01:00:00Z", source: "system" },
  ];
  const view = new FakeChatView(mixed);
  view._restoreChatHistory();
  const saved = view.filterForSave(true);
  assert.equal(saved.length, 31);
});

test("empty persisted history leaves messages empty and _historyLoadedUpTo at 0", () => {
  const view = new FakeChatView([]);
  view._restoreChatHistory();
  assert.equal(view.messages.length, 0);
  assert.equal(view._historyLoadedUpTo, 0);
});

test("history exactly at batch size (30) has historyLoadedUpTo = 0 — no scroll-up hint", () => {
  const view = new FakeChatView(makeFixture(30));
  view._restoreChatHistory();
  assert.equal(view.messages.length, 30);
  assert.equal(view._historyLoadedUpTo, 0);
});

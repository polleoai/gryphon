/**
 * Issue #35 regression: `[gryphon-context]` / `[gryphon-reminder]` composite
 * blocks must NOT leak into the user-visible chat bubble after restart, and
 * any composite that historically landed in `chat-history.json` (because the
 * CC `.jsonl` source persisted what Gryphon sent it, then a session-id
 * rotation copied that composite into `chat-history.json` on the next save)
 * must be migrated out on the first load.
 *
 * Three guarantees verified:
 *
 *   1. Load-side migration: a `chat-history.json` containing literal
 *      `[gryphon-context]` user text is rewritten on disk during
 *      `_loadChatHistory()` so the leak heals on the first restart after
 *      upgrade.
 *
 *   2. Save-side defense-in-depth: if anything else slips a composite into
 *      `this.messages`, `_doSaveChatHistory()` strips before persisting —
 *      without mutating the live in-memory message (so the chat view
 *      renders consistently within the running session).
 *
 *   3. Strip is idempotent: subsequent saves of an already-clean file leave
 *      it byte-identical (no spurious migration log spam, no churn).
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { GryphonChatView } = require("../src/chat-view");

const COMPOSITE =
  "[gryphon-context]\nactive_file: \"x.md\"\n[/gryphon-context]\n\nhello world";
const CLEAN = "hello world";

function makeFakeView(historyPath) {
  const stub = {
    messages: [],
    _pendingLoadWarning: null,
    _chatHistorySaveError: null,
    plugin: {
      settings: {
        lastSessionId: null,
        providerPreference: "anthropic-api", // skip CC jsonl source
      },
    },
    app: { vault: { adapter: { basePath: path.dirname(historyPath) } } },
  };
  stub._chatHistoryPath = () => historyPath;
  stub._flashStatus = () => {};
  stub._stripContextBlock =
    GryphonChatView.prototype._stripContextBlock.bind(stub);
  stub._loadChatHistory =
    GryphonChatView.prototype._loadChatHistory.bind(stub);
  stub._doSaveChatHistory =
    GryphonChatView.prototype._doSaveChatHistory.bind(stub);
  return stub;
}

test("issue #35: load migrates composite blocks out of chat-history.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-issue35-load-"));
  try {
    const historyPath = path.join(tmpDir, "chat-history.json");
    fs.writeFileSync(
      historyPath,
      JSON.stringify([
        {
          role: "user",
          text: COMPOSITE,
          ts: "2026-04-01T00:00:00Z",
          source: "llm",
          sessionId: "old-A",
        },
        {
          role: "assistant",
          text: "ok",
          ts: "2026-04-01T00:00:01Z",
          source: "llm",
          sessionId: "old-A",
        },
      ]),
    );

    const view = makeFakeView(historyPath);
    view._loadChatHistory();

    const onDisk = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    assert.strictEqual(
      onDisk[0].text,
      CLEAN,
      "migration must strip composite from chat-history.json on first load",
    );
    assert.strictEqual(
      onDisk[1].text,
      "ok",
      "non-user / non-composite messages must be untouched",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("issue #35: save strips composite even if it sneaks into this.messages", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-issue35-save-"));
  try {
    const historyPath = path.join(tmpDir, "chat-history.json");
    const view = makeFakeView(historyPath);

    // Simulate a buggy write site that pushed composite text directly.
    const liveMsg = {
      role: "user",
      text: COMPOSITE,
      ts: "2026-04-01T00:00:00Z",
      source: "user", // non-llm so the save filter keeps it
    };
    view.messages = [liveMsg];

    const ok = await view._doSaveChatHistory();
    assert.strictEqual(ok, true, "save must succeed");

    const onDisk = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    assert.strictEqual(
      onDisk[0].text,
      CLEAN,
      "save must strip composite from persisted text",
    );

    // Live in-memory message must remain untouched — clone-not-mutate
    // is critical so the running chat view doesn't suddenly re-render
    // bubbles with different text mid-session.
    assert.strictEqual(
      liveMsg.text,
      COMPOSITE,
      "save must not mutate the live in-memory message object",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("issue #36 follow-on: load merges dedupe duplicate user prompts within 10s", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-issue36-dedup-"));
  try {
    const historyPath = path.join(tmpDir, "chat-history.json");
    // Simulate a chat-history.json with the prompt tagged failed=true
    // (saved after my fix preserved the aborted prompt). Two entries
    // for the same prompt — close timestamps simulate the case where
    // CC's jsonl entry would normally also be merged in. Without
    // dedupe, both render as separate user bubbles after reload.
    fs.writeFileSync(
      historyPath,
      JSON.stringify([
        {
          role: "user",
          text: "summarize this file",
          ts: "2026-04-01T00:00:00Z",
          source: "llm",
          sessionId: "old-session",
          failed: true,
        },
        // The duplicate that CC's jsonl would push if it was loaded —
        // simulated here as a separate entry already in the file. ts
        // differs by 2s (within the 10s dedupe window).
        {
          role: "user",
          text: "summarize this file",
          ts: "2026-04-01T00:00:02Z",
          source: "llm",
          sessionId: "old-session",
        },
      ]),
    );
    const view = makeFakeView(historyPath);
    const merged = view._loadChatHistory();
    const userPrompts = merged.filter((m) => m.role === "user");
    assert.strictEqual(userPrompts.length, 1,
      "duplicate user prompts within 10s must collapse to one entry");
    assert.strictEqual(userPrompts[0].failed, true,
      "the failed-flagged entry must be preferred (round-trips the marker)");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("issue #36 follow-on: distinct user prompts stay distinct (different text)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-issue36-distinct-"));
  try {
    const historyPath = path.join(tmpDir, "chat-history.json");
    fs.writeFileSync(
      historyPath,
      JSON.stringify([
        { role: "user", text: "prompt A", ts: "2026-04-01T00:00:00Z", source: "llm" },
        { role: "user", text: "prompt B", ts: "2026-04-01T00:00:01Z", source: "llm" },
      ]),
    );
    const view = makeFakeView(historyPath);
    const merged = view._loadChatHistory();
    const userPrompts = merged.filter((m) => m.role === "user");
    assert.strictEqual(userPrompts.length, 2,
      "different prompt texts must NOT dedupe even if timestamps are close");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("issue #36 follow-on: same text outside 10s window stays as 2 entries", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-issue36-window-"));
  try {
    const historyPath = path.join(tmpDir, "chat-history.json");
    // User intentionally re-sent the same prompt 30s later — that's
    // a deliberate retry, NOT a load-merge duplicate. Must persist.
    fs.writeFileSync(
      historyPath,
      JSON.stringify([
        { role: "user", text: "same prompt", ts: "2026-04-01T00:00:00Z", source: "llm" },
        { role: "user", text: "same prompt", ts: "2026-04-01T00:00:30Z", source: "llm" },
      ]),
    );
    const view = makeFakeView(historyPath);
    const merged = view._loadChatHistory();
    const userPrompts = merged.filter((m) => m.role === "user");
    assert.strictEqual(userPrompts.length, 2,
      "deliberate re-sends >10s apart are distinct user actions; do not dedupe");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("issue #35 defense-in-depth: _renderMessage strips composite from user bubbles", () => {
  // Athena vendor user reported the composite STILL appearing in their
  // bubble after the load/save fix. Root cause turned out to be a
  // pre-fix session whose in-memory this.messages already had composite
  // entries (load-time migration didn't run because it was loaded
  // before the fix shipped). The render-time strip closes that residual
  // path so the bubble shows clean text regardless of what got into
  // this.messages.
  const stub = {};
  stub._stripContextBlock =
    GryphonChatView.prototype._stripContextBlock.bind(stub);

  const composite =
    "[gryphon-context]\nactive_file: \"x.md\"\n[/gryphon-context]\n\nhello world";
  const cleaned = stub._stripContextBlock(composite);
  assert.strictEqual(cleaned, "hello world",
    "render-time strip must produce the same clean text the load/save path produces");
});

test("issue #35: clean chat-history.json round-trips byte-identical (no migration churn)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-issue35-noop-"));
  try {
    const historyPath = path.join(tmpDir, "chat-history.json");
    const cleanPersisted = JSON.stringify([
      {
        role: "user",
        text: CLEAN,
        ts: "2026-04-01T00:00:00Z",
        source: "user",
      },
    ]);
    fs.writeFileSync(historyPath, cleanPersisted);
    const beforeMtime = fs.statSync(historyPath).mtimeMs;

    const view = makeFakeView(historyPath);
    view._loadChatHistory();

    const after = fs.readFileSync(historyPath, "utf8");
    assert.strictEqual(
      after,
      cleanPersisted,
      "already-clean file must not be rewritten by the migration path",
    );
    // Best-effort: mtime should also be unchanged. Some filesystems have
    // coarse mtime granularity; allow a small tolerance.
    const afterMtime = fs.statSync(historyPath).mtimeMs;
    assert.ok(
      Math.abs(afterMtime - beforeMtime) < 50,
      `mtime should be unchanged on no-op load (before=${beforeMtime} after=${afterMtime})`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

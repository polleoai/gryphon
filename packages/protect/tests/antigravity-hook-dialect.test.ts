// Antigravity hook dialect — payload translation.
//
// Antigravity is the first provider whose hook INPUT differs from the
// Claude-Code wire shape. Claude/Codex/Gemini all send flat snake_case
// (`tool_name`, `tool_input`, `session_id`); Antigravity sends camelCase
// with a nested tool call:
//
//   { toolCall: { name, args }, conversationId, stepIdx, workspacePaths }
//
// and its tool vocabulary + argument field names are its own. All shapes
// below were captured from a live `agy` v1.1.8 PreToolUse payload, not
// inferred from docs.
//
// Getting this mapping wrong does not throw — it produces a payload the
// classifier cannot read, which returns "not protected", which means the
// guardrail silently passes everything. That is the exact failure class
// this dialect exists to close, so it is pinned here.

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeAntigravityInput } = require("../src/hooks/common/dialects");

test("run_command → Bash with the full command line (live-captured shape)", () => {
  const out = normalizeAntigravityInput({
    toolCall: {
      name: "run_command",
      args: { CommandLine: "echo ALPHA-BRAVO --flag=1", Cwd: "/scratch", WaitMsBeforeAsync: 1000 },
    },
    conversationId: "276a5773-a8ed-4384-9e22-2c80676a396f",
    stepIdx: 3,
    workspacePaths: ["/vault"],
  });
  assert.equal(out.tool_name, "run_command");
  assert.equal(out.tool_input.command, "echo ALPHA-BRAVO --flag=1",
    "the classifier scans `command`; without this mapping every protected-command rule silently misses");
  assert.equal(out.session_id, "276a5773-a8ed-4384-9e22-2c80676a396f");
  assert.equal(out.cwd, "/scratch", "run_command's own Cwd wins over the workspace root");
});

test("run_command falls back to the workspace root when Cwd is absent", () => {
  const out = normalizeAntigravityInput({
    toolCall: { name: "run_command", args: { CommandLine: "ls" } },
    workspacePaths: ["/vault", "/other"],
  });
  assert.equal(out.cwd, "/vault");
});

test("write_to_file → file_path from TargetFile (live-captured shape)", () => {
  const out = normalizeAntigravityInput({
    toolCall: {
      name: "write_to_file",
      args: {
        TargetFile: "/vault/.obsidian/plugins/gryphon/data.json",
        CodeContent: "HELLO",
        Overwrite: true,
        Description: "write it",
      },
    },
    conversationId: "c1",
  });
  assert.equal(out.tool_name, "write_to_file");
  assert.equal(out.tool_input.file_path, "/vault/.obsidian/plugins/gryphon/data.json",
    "protected-path rules read file_path; TargetFile alone would never match");
  assert.equal(out.tool_input.content, "HELLO");
});

test("view_file → file_path from AbsolutePath (live-captured shape)", () => {
  const out = normalizeAntigravityInput({
    toolCall: { name: "view_file", args: { AbsolutePath: "/vault/notes/secret.md" } },
  });
  assert.equal(out.tool_input.file_path, "/vault/notes/secret.md");
});

test("replace_file_content → file_path from TargetFile (live-captured shape)", () => {
  const out = normalizeAntigravityInput({
    toolCall: {
      name: "replace_file_content",
      args: {
        TargetFile: "/vault/.obsidian/plugins/gryphon/data.json",
        TargetContent: "bravo",
        ReplacementContent: "DELTA",
        StartLine: 2, EndLine: 2, AllowMultiple: false, Instruction: "swap it",
      },
    },
  });
  assert.equal(out.tool_input.file_path, "/vault/.obsidian/plugins/gryphon/data.json",
    "in-place edits must hit protected-path rules exactly like write_to_file");
  assert.equal(out.tool_input.content, "DELTA");
});

test("read-only tools map onto the canonical field names (live-captured shapes)", () => {
  const dir = normalizeAntigravityInput({
    toolCall: { name: "list_dir", args: { DirectoryPath: "/vault/notes" } },
  });
  assert.equal(dir.tool_input.path, "/vault/notes");
  const grep = normalizeAntigravityInput({
    toolCall: { name: "grep_search", args: { Query: "password", SearchPath: "/vault" } },
  });
  assert.equal(grep.tool_input.pattern, "password");
  assert.equal(grep.tool_input.path, "/vault");
});

test("an unmapped mutating tool still carries its original args through", () => {
  // delete_directory's shape was never captured live. The mapping is a
  // convention-based guess, so the guarantee that matters is that a wrong
  // guess degrades to "unmapped" rather than dropping the payload.
  const out = normalizeAntigravityInput({
    toolCall: { name: "delete_directory", args: { SomeUnexpectedKey: "/vault/notes" } },
  });
  assert.equal(out.tool_name, "delete_directory");
  assert.equal(out.tool_input.SomeUnexpectedKey, "/vault/notes",
    "originals must survive so a future mapper (or the classifier) can still see them");
});

test("unknown tools pass through with args intact rather than being dropped", () => {
  const out = normalizeAntigravityInput({
    toolCall: { name: "some_future_tool", args: { Whatever: 1 } },
  });
  assert.equal(out.tool_name, "some_future_tool");
  assert.deepEqual(out.tool_input.Whatever, 1,
    "an unmapped tool must still reach the classifier — it decides, not the normalizer");
});

test("a malformed payload yields no tool_name rather than throwing", () => {
  for (const bad of [null, undefined, {}, { toolCall: null }, { toolCall: { name: 42 } }]) {
    const out = normalizeAntigravityInput(bad);
    assert.ok(out === null || typeof out.tool_name !== "string" || out.tool_name.length === 0 || out.tool_name === "42",
      `malformed input must not throw: ${JSON.stringify(bad)}`);
  }
});

// ── Output shape ─────────────────────────────────────────────────────────

test("buildAntigravityDecision emits the flat decision/reason shape agy expects", () => {
  const { buildAntigravityDecision } = require("../src/hooks/common/dialects");
  const denied = buildAntigravityDecision("deny", "Protected path.");
  assert.equal(denied.decision, "deny",
    "'deny' is the only value that hard-blocks; verified live to block even under --dangerously-skip-permissions");
  assert.equal(denied.reason, "Protected path.");
  assert.equal(denied.hookSpecificOutput, undefined, "no Claude-style envelope");
});

test("buildAntigravityDecision maps Gryphon's 'ask' onto Antigravity's force_ask", () => {
  const { buildAntigravityDecision } = require("../src/hooks/common/dialects");
  // Antigravity's plain "ask" respects its cached "Always Allow" grants;
  // a Gryphon protected-op prompt must not be silently satisfied by a
  // cache entry the user created in their own interactive session.
  assert.equal(buildAntigravityDecision("ask", "Confirm?").decision, "force_ask");
});

test("buildAntigravityDecision allows without a reason field", () => {
  const { buildAntigravityDecision } = require("../src/hooks/common/dialects");
  const allowed = buildAntigravityDecision("allow", null);
  assert.equal(allowed.decision, "allow");
  assert.equal("reason" in allowed, false);
});

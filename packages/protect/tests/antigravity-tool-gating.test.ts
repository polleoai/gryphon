/**
 * Every Antigravity tool must reach the classifier under a canonical name.
 *
 * A tool missing from TOOL_ALIASES does not error — `classify` falls through
 * to "not currently gated" and returns null, so the operation is allowed. No
 * log line, no warning, nothing. That is how v2.9.1 and v2.9.2 shipped with
 * ONLY `run_command` mapped: every file-mutating Antigravity tool bypassed
 * protected-path enforcement entirely, including writes to
 * `.obsidian/plugins/gryphon/` — the highest-impact escalation path in
 * DEFAULT_PROTECTED_PATHS.
 *
 * The adapter's own comment claimed a match-all matcher meant "every
 * file-mutating tool is gated". The matcher was match-all; the alias table
 * was not. Both halves are required, and only an end-to-end test noticed
 * (04-hook-spawn), because every unit test asked the classifier about Claude
 * tool names.
 *
 * Gating a tool takes TWO things, in two different files:
 *   1. a name alias here, so `classify` routes it to a gated branch
 *   2. an argument-field mapping in hooks/common/dialects.ts, so the branch
 *      finds `command` / `file_path` where Antigravity put `CommandLine` /
 *      `TargetFile`
 * This file pins (1); antigravity-hook-dialect.test.ts pins (2).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeToolName } = require("../src/attack-detector");
const { ARG_MAPPERS } = require("../src/hooks/common/dialects");

// Tool names observed live from agy v1.1.8 payloads, plus the mutating tools
// named in its step-type table. Value = the Claude-vocabulary branch the
// classifier must route to.
const ANTIGRAVITY_TOOLS = {
  // Command execution — the reverse-shell / package-install axis.
  run_command: "Bash",
  // File mutation — the protected-path axis.
  write_to_file: "Write",
  replace_file_content: "Edit",
  propose_code: "Edit",
  edit_notebook: "Edit",
  delete_directory: "Write",
  // Read-only. Not gated by design, but must still normalize so the UI shows
  // a plain-language label instead of a raw Antigravity identifier.
  view_file: "Read",
  list_dir: "Glob",
  grep_search: "Grep",
};

const GATED = new Set(["Bash", "PowerShell", "Write", "Edit"]);

for (const [tool, expected] of Object.entries(ANTIGRAVITY_TOOLS)) {
  test(`${tool} normalizes to ${expected}`, () => {
    assert.equal(
      normalizeToolName(tool), expected,
      `${tool} is unmapped, so classify() returns null and the operation is ALLOWED silently`,
    );
  });
}

test("every MUTATING Antigravity tool lands on a gated branch", () => {
  const mutating = ["run_command", "write_to_file", "replace_file_content",
                    "propose_code", "edit_notebook", "delete_directory"];
  const ungated = mutating.filter((t) => !GATED.has(normalizeToolName(t)));
  assert.deepEqual(
    ungated, [],
    `these mutate the machine but never reach the permission gate: ${ungated.join(", ")}`,
  );
});

test("read-only Antigravity tools are NOT routed to a gated branch", () => {
  // Gating reads would prompt on ordinary navigation and train users to
  // click through the modal — which costs more than it protects.
  for (const tool of ["view_file", "list_dir", "grep_search"]) {
    assert.ok(!GATED.has(normalizeToolName(tool)), `${tool} should not be gated`);
  }
});

test("every tool with an argument mapper also has a name alias", () => {
  // The two tables are edited in different files and drift apart silently:
  // an arg mapper without an alias produces a correctly-shaped payload for a
  // tool the classifier never inspects.
  const orphans = Object.keys(ARG_MAPPERS).filter((t) => normalizeToolName(t) === t);
  assert.deepEqual(
    orphans, [],
    `have arg mappers but no alias, so they are never classified: ${orphans.join(", ")}`,
  );
});

// ── Unknown / unmapped Antigravity tools must still reach the gate ────────
//
// Two tables are required for a tool to be gated: TOOL_ALIASES maps the NAME,
// and dialects.ts maps the ARGUMENTS. Getting only the first produces a tool
// that routes to the file branch and then finds no `file_path` — a silent
// allow that looks like coverage. v2.9.1/2.9.2 had neither for anything but
// run_command.
//
// agy's v1.1.8 binary carries 100+ tool identifiers and exposes different
// subsets by mode, so an enumeration will always lag its releases. These pin
// the generic derivation instead: a tool nobody has mapped, carrying a
// recognisable path field, must still be gated.

const { normalizeAntigravityInput } = require("../src/hooks/common/dialects");

// NOTE the precise claim: this covers the ARGUMENT half. The tool name must
// still be in TOOL_ALIASES for classify() to gate it at all — see the scope
// note in dialects.ts. Named to avoid implying more coverage than exists.
test("a tool with no explicit mapper still yields a usable path from its raw args", () => {
  const n = normalizeAntigravityInput({
    toolCall: {
      name: "some_tool_shipped_next_year",
      args: { TargetFile: "/vault/.obsidian/plugins/gryphon/data.json", Body: "x" },
    },
    conversationId: "c1",
  });
  assert.equal(n.tool_input.file_path, "/vault/.obsidian/plugins/gryphon/data.json",
    "an aliased tool with no bespoke mapper must not lose its path");
});

test("a tool with no explicit mapper still yields a command from its raw args", () => {
  const n = normalizeAntigravityInput({
    toolCall: { name: "shell_exec", args: { Command: "rm -rf /vault/.obsidian" } },
    conversationId: "c1",
  });
  assert.equal(n.tool_input.command, "rm -rf /vault/.obsidian");
});

test("explicit mappers still win over the generic fallback", () => {
  // write_to_file carries BOTH TargetFile and CodeContent; the explicit mapper
  // must set content too, which the generic path fallback cannot do.
  const n = normalizeAntigravityInput({
    toolCall: { name: "write_to_file", args: { TargetFile: "/a/b.md", CodeContent: "hello" } },
    conversationId: "c1",
  });
  assert.equal(n.tool_input.file_path, "/a/b.md");
  assert.equal(n.tool_input.content, "hello");
});

test("a tool with no path-like field at all is left alone, not invented", () => {
  const n = normalizeAntigravityInput({
    toolCall: { name: "notify_user", args: { Message: "hi" } },
    conversationId: "c1",
  });
  assert.equal(n.tool_input.file_path, undefined,
    "fabricating a path would gate things that touch no file");
  assert.equal(n.tool_input.command, undefined);
});

test("the mutating tools enumerated from the agy binary are aliased", () => {
  const { TOOL_ALIASES } = require("../src/attack-detector");
  const mustBeGated = [
    "run_command", "shell_exec", "send_command_input", "execute_notebook",
    "execute_browser_javascript", "restart_dev_server",
    "install_applet_dependencies", "install_applet_package",
    "write_to_file", "replace_file_content", "propose_code",
    "edit_notebook", "notebook_edit", "delete_directory", "write_blob", "move",
  ];
  for (const t of mustBeGated) {
    const canonical = TOOL_ALIASES[t];
    assert.ok(["Bash", "Write", "Edit"].includes(canonical),
      `${t} mutates state and must map to a gated canonical tool, got ${canonical}`);
  }
});

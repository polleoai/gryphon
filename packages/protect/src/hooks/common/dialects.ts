// TypeScript module marker.

/**
 * Per-CLI hook payload dialects.
 *
 * Claude Code, Codex CLI and Gemini CLI all send the SAME hook input shape
 * (flat snake_case: `tool_name`, `tool_input`, `session_id`) and differ only
 * in their OUTPUT shape — which is why `pretool.ts` historically only needed
 * an output switch.
 *
 * Antigravity breaks that assumption on both axes, so its translation lives
 * here rather than inline:
 *
 *   Input  { toolCall: { name, args }, conversationId, stepIdx,
 *            workspacePaths, transcriptPath, modelName }   (camelCase)
 *   Output { decision: allow|deny|ask|force_ask, reason }
 *
 * Every shape below was captured from a live `agy` v1.1.8 PreToolUse
 * payload, not inferred from documentation.
 *
 * Why this matters more than it looks: a wrong field name here does not
 * throw. It hands the classifier a payload with no `command` / `file_path`,
 * the classifier correctly reports "not a protected operation", and the
 * guardrail passes everything silently. Fail-closed protects us against
 * crashes, not against mis-mapping — only these tests do.
 */

/**
 * Antigravity tool name → the Claude-Code-vocabulary argument fields the
 * classifier reads. `attack-detector`'s TOOL_ALIASES maps the NAMES; this
 * maps the ARGUMENT shapes, which aliases alone cannot do.
 *
 * Verified live (agy v1.1.8) — every entry below marked "captured" was read
 * off a real PreToolUse payload:
 *   run_command          { CommandLine, Cwd, WaitMsBeforeAsync }
 *   write_to_file        { TargetFile, CodeContent, Overwrite, Description }
 *   view_file            { AbsolutePath }
 *   replace_file_content { TargetFile, TargetContent, ReplacementContent,
 *                          StartLine, EndLine, Instruction, AllowMultiple,
 *                          Description }
 *   list_dir             { DirectoryPath }
 *   grep_search          { Query, SearchPath }
 *   ask_permission       { Action, Reason, Target }
 */
/**
 * Field names Antigravity uses for a filesystem path, most specific first.
 * Used as a fallback when a tool has no explicit mapper — see the derivation
 * below `ARG_MAPPERS`. Drawn from the live-captured tools plus the argument
 * naming convention visible across agy v1.1.8's tool identifiers.
 */
const ANTIGRAVITY_PATH_FIELDS = [
  "TargetFile", "AbsolutePath", "FilePath", "NotebookPath",
  "TargetPath", "DestinationFile", "DestinationPath", "SourceFile",
  "TargetDirectory", "DirectoryPath", "Path",
];

/** Field names Antigravity uses for a shell command string. */
const ANTIGRAVITY_COMMAND_FIELDS = ["CommandLine", "Command", "Script", "Input"];

const ARG_MAPPERS: Record<string, (args: Record<string, any>) => Record<string, unknown>> = {
  run_command: (args) => ({
    ...args,
    command: args.CommandLine,
  }),
  write_to_file: (args) => ({
    ...args,
    file_path: args.TargetFile,
    content: args.CodeContent,
  }),
  view_file: (args) => ({
    ...args,
    file_path: args.AbsolutePath,
  }),
  // Antigravity's in-place edit tool — captured live; TargetFile confirmed.
  replace_file_content: (args) => ({
    ...args,
    file_path: args.TargetFile,
    content: args.ReplacementContent,
  }),
  // Read-only tools. Not gated (the classifier returns null for them), but
  // mapped so downstream consumers like chat-view's status-line normalizer
  // show "Searching…" / "Listing…" instead of a raw Antigravity identifier.
  list_dir: (args) => ({
    ...args,
    path: args.DirectoryPath,
  }),
  grep_search: (args) => ({
    ...args,
    pattern: args.Query,
    path: args.SearchPath,
  }),
  // NOT captured live — the shape probe never reached them (the deny fired
  // on an earlier step). Mapped on Antigravity's observed conventions
  // (`TargetFile` for files, `DirectoryPath` for directories, both confirmed
  // on sibling tools). The spread preserves the originals either way, so a
  // wrong guess degrades to "unmapped", never to corrupted input.
  propose_code: (args) => ({
    ...args,
    file_path: args.TargetFile,
  }),
  edit_notebook: (args) => ({
    ...args,
    file_path: args.TargetFile,
  }),
  delete_directory: (args) => ({
    ...args,
    file_path: args.DirectoryPath || args.TargetDirectory || args.AbsolutePath,
  }),
};

/**
 * Translate an Antigravity PreToolUse/PostToolUse payload into the canonical
 * Claude-Code-shaped input the rest of the hook pipeline speaks.
 *
 * Returns null for input that carries no tool call at all. Never throws —
 * the caller is a fail-closed hook and must be able to deny cleanly.
 */
function normalizeAntigravityInput(input: any) {
  if (!input || typeof input !== "object") return null;
  const call = input.toolCall;
  if (!call || typeof call !== "object") return null;

  const name = call.name;
  const rawArgs = (call.args && typeof call.args === "object") ? call.args : {};
  const mapper = typeof name === "string" ? ARG_MAPPERS[name] : null;
  const toolInput: Record<string, any> = mapper ? mapper(rawArgs) : { ...rawArgs };

  // Generic fallback for tools we have no explicit mapper for.
  //
  // Without this, an unmapped tool is a SILENT BYPASS even when its name is
  // aliased to Write: the alias routes it to the file branch, the branch looks
  // for `file_path`, Antigravity supplies `TargetFile`, no path is found and
  // nothing matches a protected rule. Enumerating tool names does not fix that
  // on its own — both halves are required, which is the same trap that left
  // every file-mutating agy tool ungated in 2.9.1/2.9.2.
  //
  // SCOPE, stated precisely so this is not over-read: this closes the
  // ARGUMENT half only. Gating still requires the tool NAME to be in
  // TOOL_ALIASES — attack-detector.ts resolves `TOOL_ALIASES[tool] || tool`,
  // and an unrecognised name falls through to the "not currently gated"
  // branch. So this makes every alias we add work WITHOUT a bespoke mapper;
  // it does not gate a tool agy ships that nobody has aliased yet.
  //
  // That residual gap is real: agy v1.1.8's binary carries 100+ tool
  // identifiers and exposes different subsets by mode, so the alias table
  // will lag its releases. Closing it needs a name-independent rule (e.g.
  // "carries both a path and a content field ⇒ treat as a write"), which is
  // a change to the classifier's default rather than to this mapping layer.
  // Tracked in docs/code-review-findings.md.
  if (typeof toolInput.file_path !== "string" || !toolInput.file_path) {
    for (const f of ANTIGRAVITY_PATH_FIELDS) {
      if (typeof rawArgs[f] === "string" && rawArgs[f]) { toolInput.file_path = rawArgs[f]; break; }
    }
  }
  if (typeof toolInput.command !== "string" || !toolInput.command) {
    for (const f of ANTIGRAVITY_COMMAND_FIELDS) {
      if (typeof rawArgs[f] === "string" && rawArgs[f]) { toolInput.command = rawArgs[f]; break; }
    }
  }

  // A tool's own working directory is more specific than the workspace
  // root — `agy` runs commands from its own scratch dir by default, and a
  // path rule evaluated against the wrong cwd resolves the wrong file.
  const workspace = Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : null;
  const cwd = (rawArgs && rawArgs.Cwd) || workspace || null;

  return {
    tool_name: name,
    tool_input: toolInput,
    session_id: input.conversationId || null,
    cwd,
    // Antigravity has no per-call permission-mode field; the plugin's own
    // setting governs. Left null so `classify` falls back to it.
    permission_mode: null,
  };
}

/**
 * Build Antigravity's PreToolUse output.
 *
 * `deny` hard-blocks the tool immediately — verified live to hold even when
 * the provider spawns with `--dangerously-skip-permissions` (which it must,
 * because without it headless `agy` auto-denies every tool it cannot prompt
 * for and the provider is unusable).
 *
 * Gryphon's "ask" maps to `force_ask`, NOT `ask`: plain `ask` respects
 * Antigravity's cached "Always Allow" grants, so a protected-operation
 * prompt could be silently satisfied by a grant the user made in their own
 * interactive session, outside Obsidian.
 */
function buildAntigravityDecision(decision: string, reason?: string | null) {
  const mapped = decision === "ask" ? "force_ask" : decision;
  return Object.assign(
    { decision: mapped },
    reason ? { reason } : {},
  );
}

module.exports = {
  normalizeAntigravityInput,
  buildAntigravityDecision,
  ARG_MAPPERS,
};

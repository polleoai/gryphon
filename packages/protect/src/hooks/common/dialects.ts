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
 * Verified live (agy v1.1.8):
 *   run_command   { CommandLine, Cwd, WaitMsBeforeAsync }
 *   write_to_file { TargetFile, CodeContent, Overwrite, Description }
 *   view_file     { AbsolutePath }
 */
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
  // Antigravity's in-place edit tool. Field names follow write_to_file's
  // TargetFile convention; NOT captured live, so the spread above keeps the
  // originals intact and the classifier still sees TargetFile if the mapped
  // name is ever wrong.
  replace_file_content: (args) => ({
    ...args,
    file_path: args.TargetFile,
  }),
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
  const toolInput = mapper ? mapper(rawArgs) : { ...rawArgs };

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

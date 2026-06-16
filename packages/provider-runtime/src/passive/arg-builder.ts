// packages/provider-runtime/src/passive/arg-builder.ts
// PURE: PassiveSessionConfig -> clean-room claude CLI argv. No spawn, no I/O.
//
// See docs/superpowers/specs/2026-06-14-passive-backend-design.md §5.

// C6 — every built-in tool denied so the model can ONLY call caller-declared
// tools (which live in the Phase B MCP shim). Order is stable for testability.
const DISALLOWED_BUILTINS = [
  "Bash", "Write", "Read", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit",
];

function buildPassiveArgs(config: any, opts: any = {}): string[] {
  const args = [
    // Persistent stream-json transport (D2) — NO --print. The parked-IPC
    // model needs claude alive across the tool_use->tool_result boundary;
    // the existing ClaudeCodeProvider already proves persistent-no-print works.
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    // No --include-partial-messages: the parser consumes whole `assistant` /
    // `result` events, not streamed deltas, so partial frames are pure noise.
    "--model", String(config.model),
    // C3 — REPLACE the system prompt (empty string is a valid replace, never
    // --append-system-prompt: the caller's protocol must dominate).
    "--system-prompt", String(config.systemPrompt ?? ""),
    // C4 — only MCP servers from --mcp-config; ignore inherited config
    // (claude.ai connectors, project/user MCPs).
    "--strict-mcp-config",
    // C5 — skip ALL user/project/local settings (and their SessionStart
    // hooks, C12). The caller's systemPrompt is the only protocol input.
    "--setting-sources", "",
    // C6 — deny every built-in tool.
    "--disallowedTools", DISALLOWED_BUILTINS.join(","),
  ];
  if (typeof config.maxThinkingTokens === "number") {
    args.push("--max-thinking-tokens", String(config.maxThinkingTokens));
  }
  // Pre-authorize the declared MCP tools (namespaced mcp__<server>__<name>).
  // Spike refinement #2: without this, claude hits a permission gate and
  // abandons the tool call with an "I need permission…" text turn instead of
  // calling it. See design spec §12.
  if (Array.isArray(opts.allowedTools) && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  if (opts.mcpConfigPath) {
    args.push("--mcp-config", String(opts.mcpConfigPath));
  }
  return args;
}

module.exports = { buildPassiveArgs, DISALLOWED_BUILTINS };

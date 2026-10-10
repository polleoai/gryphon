// TypeScript module marker.

/**
 * Cross-CLI tool-name aliases. Different CLIs name the same tool
 * differently — Claude Code's "Bash" is Gemini's "run_shell_command",
 * Codex's "command_execution", and so on. The classifier internally
 * speaks Claude Code's tool vocabulary (Bash / Write / Edit /
 * PowerShell), so we normalize incoming names before dispatching.
 *
 * Adding a new CLI = add its tool names here. The classifier itself
 * stays vocabulary-pure.
 */
const TOOL_ALIASES: Record<string, string> = Object.freeze({
  // Shell / command execution
  "Bash": "Bash",
  "PowerShell": "PowerShell",
  "run_shell_command": "Bash",  // Gemini CLI / Gemini SDK
  "shell": "Bash",              // Gemini variants seen in older builds
  "bash": "Bash",                // ditto
  "command_execution": "Bash",   // Codex JSONL item.type (defensive — Codex's hook
                                  //   uses tool_name, not item.type, but hook input
                                  //   shape may evolve)
  "run_command": "Bash",         // Antigravity CLI (`agy`) — args {CommandLine, Cwd};
                                  //   the field mapping lives in hooks/dialects.ts,
                                  //   since an alias can rename a tool but not its args
  // File mutation
  "Write": "Write",
  "Edit": "Edit",
  "MultiEdit": "Edit",           // Claude Code — {file_path, edits[]}
  "NotebookEdit": "Edit",        // Claude Code — {notebook_path, ...}; see classify()
  "write_file": "Write",         // Gemini CLI / SDK
  "replace": "Edit",             // Gemini CLI / SDK
  "edit_file": "Edit",           // Gemini variant
  // Antigravity CLI (`agy`). A tool absent from this table falls through to
  // "not currently gated" — silently, with no error anywhere. v2.9.1/2.9.2
  // shipped with only `run_command` mapped, so every file-mutating
  // Antigravity tool bypassed protected-path enforcement entirely, including
  // writes to Gryphon's own plugin folder. Caught by the 04-hook-spawn E2E
  // spec, not by any unit test. Argument-field mapping is separate and lives
  // in hooks/common/dialects.ts — an alias renames a tool, not its args, and
  // BOTH are required for a tool to actually be gated.
  "write_to_file": "Write",        // {TargetFile, CodeContent} — captured live
  "replace_file_content": "Edit",  // {TargetFile, ReplacementContent} — captured live
  "apply_patch": "Edit",           // Codex — {command: "*** Begin Patch …"}; targets via patchTargets (R43-3)
  "propose_code": "Edit",
  "edit_notebook": "Edit",
  // Mutates a path, so it belongs on the file branch: this is what makes
  // protected-path rules apply to a directory deletion.
  "delete_directory": "Write",
  // Enumerated from the agy v1.1.8 binary's embedded tool identifiers
  // (2026-07-30), not from docs — agy publishes no tool list. Its surface is
  // far larger than the handful seen in live turns and varies by mode, so
  // these are mapped defensively: an extra alias costs nothing, a missing one
  // is a silent bypass. Argument fields for these are NOT live-captured; the
  // generic path/command derivation in hooks/common/dialects.ts is what makes
  // them gate correctly without a per-tool mapper.
  "shell_exec": "Bash",
  "send_command_input": "Bash",          // drives an already-running command
  "execute_notebook": "Bash",            // arbitrary code execution
  "execute_browser_javascript": "Bash",
  "restart_dev_server": "Bash",
  "install_applet_dependencies": "Bash", // package installs — see blockPackageInstall
  "install_applet_package": "Bash",
  "notebook_edit": "Edit",               // binary carries BOTH spellings of this
  "write_blob": "Write",
  "move": "Write",                       // mutates destination, removes source
  // File read — not protected (read-only tools never reach the
  // permission gate), but listed here so downstream consumers like
  // chat-view's status-line normalizer can map snake_case SDK names
  // ("read_file") to a single user-friendly label ("Reading...")
  // without leaking the raw identifier into the UI.
  "Read": "Read",
  "read_file": "Read",           // OpenAI / Gemini SDK
  "view_file": "Read",           // Antigravity — {AbsolutePath}, captured live
  "Glob": "Glob",
  "glob": "Glob",
  "list_directory": "Glob",      // Gemini SDK
  "list_files": "Glob",          // OpenAI / common variant
  "list_dir": "Glob",            // Antigravity — {DirectoryPath}, captured live
  "Grep": "Grep",
  "grep": "Grep",
  "search_files": "Grep",        // common SDK variant
  "search_file_content": "Grep", // Gemini SDK
  "grep_search": "Grep",         // Antigravity — {Query, SearchPath}, captured live
}) as Record<string, string>;

/**
 * R43-3: Codex's `apply_patch` names its files inside the patch text, not
 * in a path argument:
 *   *** Add File: <path> / *** Update File: <path> / *** Delete File: <path>
 *   *** Move to: <path>
 * Returns every path it names, from any string argument that carries a
 * patch (including `apply_patch <<'EOF' … EOF` written as a shell command),
 * so each one can be checked like a Write/Edit target.
 *
 * It must read at least what Codex reads (codex-rs apply-patch
 * streaming_parser.rs @ rust-v0.145.0): lines split on \n with one trailing
 * \r removed; hunk headers matched after a full `str::trim()` (Unicode
 * White_Space), `Move to:` after `trim_end()` only. A path is collected
 * under every trimming variant: an extra candidate can only add a check.
 */
// Rust's char::is_whitespace (Unicode White_Space) — JS \s differs (it lacks
// U+0085 and adds U+FEFF), so both sets are applied.
const RUST_WS = "\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const RUST_TRIM_RE = new RegExp(`^[${RUST_WS}]+|[${RUST_WS}]+$`, "g");
const RUST_TRIM_END_RE = new RegExp(`[${RUST_WS}]+$`);
const HEADER_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "];
const MOVE_MARKER = "*** Move to: ";

function _lineVariants(line: string): string[] {
  const v = new Set([
    line,
    line.replace(RUST_TRIM_RE, ""),
    line.replace(RUST_TRIM_END_RE, ""),
    line.trim(),
    line.replace(RUST_TRIM_RE, "").trim(),
  ]);
  return [...v];
}

// Generous bounds: past them the caller is told (`truncated`) and must
// fail closed — a target it never saw must not read as "nothing protected".
const PATCH_MAX_TARGETS = 2000;
const PATCH_MAX_DEPTH = 8;

function _targetsFromText(text: string, out: string[], state: { truncated: boolean }): void {
  if (!text.includes("***")) return;
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.includes("***")) continue;
    for (const v of _lineVariants(line)) {
      for (const m of [...HEADER_MARKERS, MOVE_MARKER]) {
        if (!v.startsWith(m)) continue;
        const p = v.slice(m.length);
        if (!p || out.includes(p)) continue;
        if (out.length >= PATCH_MAX_TARGETS) { state.truncated = true; return; }
        out.push(p);
      }
    }
  }
}

/** Every path a patch names, and whether the scan had to stop early. */
function patchTargetsInfo(input: unknown): { targets: string[]; truncated: boolean } {
  const out: string[] = [];
  const state = { truncated: false };
  const visit = (v: unknown, depth: number) => {
    if (state.truncated) return;
    if (typeof v === "string") { _targetsFromText(v, out, state); return; }
    if (!v || typeof v !== "object") return;
    if (depth >= PATCH_MAX_DEPTH) { state.truncated = true; return; }
    for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) visit(x, depth + 1);
  };
  visit(input, 0);
  return { targets: out, truncated: state.truncated };
}

function patchTargets(input: unknown): string[] {
  return patchTargetsInfo(input).targets;
}

/**
 * Directories a shell command may `cd`/`pushd` into before patching, read
 * lexically (quotes removed). Used only as EXTRA bases for resolving a
 * patch's relative paths, so a miss here can't loosen anything.
 */
const MAX_CD_DIRS = 256;
function shellCdDirs(command: unknown): string[] {
  if (typeof command !== "string" || !/\b(?:cd|pushd|Set-Location|sl)\b/.test(command)) return [];
  const out: string[] = [];
  const re = /(?:^|[;&|\n(]|&&|\|\|)\s*(?:cd|pushd|Set-Location|sl)\s+(?:-[A-Za-z]+\s+)*("([^"]*)"|'([^']*)'|[^\s;&|)]+)/g;
  for (const m of command.matchAll(re)) {
    const d = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[1];
    // Up to MAX_CD_DIRS + 1: a caller seeing more than MAX_CD_DIRS reports
    // the command as too large rather than dropping folders (post-push
    // review of 2.11.4: folders past a silent cap were ignored).
    if (d && !out.includes(d)) { out.push(d); if (out.length > MAX_CD_DIRS) break; }
  }
  return out;
}

module.exports = { TOOL_ALIASES, patchTargets, patchTargetsInfo, shellCdDirs, MAX_CD_DIRS };

"use strict";
// TypeScript module marker.
Object.defineProperty(exports, "__esModule", { value: true });
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
const TOOL_ALIASES = Object.freeze({
    // Shell / command execution
    "Bash": "Bash",
    "PowerShell": "PowerShell",
    "run_shell_command": "Bash", // Gemini CLI / Gemini SDK
    "shell": "Bash", // Gemini variants seen in older builds
    "bash": "Bash", // ditto
    "command_execution": "Bash", // Codex JSONL item.type (defensive — Codex's hook
    //   uses tool_name, not item.type, but hook input
    //   shape may evolve)
    "run_command": "Bash", // Antigravity CLI (`agy`) — args {CommandLine, Cwd};
    //   the field mapping lives in hooks/dialects.ts,
    //   since an alias can rename a tool but not its args
    // File mutation
    "Write": "Write",
    "Edit": "Edit",
    "MultiEdit": "Edit", // Claude Code — {file_path, edits[]}
    "NotebookEdit": "Edit", // Claude Code — {notebook_path, ...}; see classify()
    "write_file": "Write", // Gemini CLI / SDK
    "replace": "Edit", // Gemini CLI / SDK
    "edit_file": "Edit", // Gemini variant
    // Antigravity CLI (`agy`). A tool absent from this table falls through to
    // "not currently gated" — silently, with no error anywhere. v2.9.1/2.9.2
    // shipped with only `run_command` mapped, so every file-mutating
    // Antigravity tool bypassed protected-path enforcement entirely, including
    // writes to Gryphon's own plugin folder. Caught by the 04-hook-spawn E2E
    // spec, not by any unit test. Argument-field mapping is separate and lives
    // in hooks/common/dialects.ts — an alias renames a tool, not its args, and
    // BOTH are required for a tool to actually be gated.
    "write_to_file": "Write", // {TargetFile, CodeContent} — captured live
    "replace_file_content": "Edit", // {TargetFile, ReplacementContent} — captured live
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
    "send_command_input": "Bash", // drives an already-running command
    "execute_notebook": "Bash", // arbitrary code execution
    "execute_browser_javascript": "Bash",
    "restart_dev_server": "Bash",
    "install_applet_dependencies": "Bash", // package installs — see blockPackageInstall
    "install_applet_package": "Bash",
    "notebook_edit": "Edit", // binary carries BOTH spellings of this
    "write_blob": "Write",
    "move": "Write", // mutates destination, removes source
    // File read — not protected (read-only tools never reach the
    // permission gate), but listed here so downstream consumers like
    // chat-view's status-line normalizer can map snake_case SDK names
    // ("read_file") to a single user-friendly label ("Reading...")
    // without leaking the raw identifier into the UI.
    "Read": "Read",
    "read_file": "Read", // OpenAI / Gemini SDK
    "view_file": "Read", // Antigravity — {AbsolutePath}, captured live
    "Glob": "Glob",
    "glob": "Glob",
    "list_directory": "Glob", // Gemini SDK
    "list_files": "Glob", // OpenAI / common variant
    "list_dir": "Glob", // Antigravity — {DirectoryPath}, captured live
    "Grep": "Grep",
    "grep": "Grep",
    "search_files": "Grep", // common SDK variant
    "search_file_content": "Grep", // Gemini SDK
    "grep_search": "Grep", // Antigravity — {Query, SearchPath}, captured live
});
module.exports = { TOOL_ALIASES };

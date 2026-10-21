/**
 * Windows-safe spawn helper for `.cmd` / `.bat` shims.
 *
 * Why this exists
 * ---------------
 * The Codex / Gemini / Claude CLIs are typically installed via npm on
 * Windows, which puts a `.cmd` shim on PATH (`codex.cmd`, `gemini.cmd`,
 * etc.). To run such a shim, Node's `child_process.spawn` needs help —
 * `.cmd` files are not executables, they're scripts that `cmd.exe`
 * runs.
 *
 * The traditional approach is `spawn(cmdPath, args, { shell: true })`,
 * which makes Node concatenate argv0 + args into a single string and
 * pass it to `cmd.exe /d /s /c "<string>"`. Two things go wrong:
 *
 *   1. Newlines in any argument terminate the cmd.exe command line. A
 *      multi-line prompt (e.g. our [gryphon-context] block has 5+
 *      lines) gets truncated at the first newline. The model only
 *      sees "[gryphon-context]" — exactly the symptom Windows users
 *      reported on 2026-05-04: Codex says "I don't have any context
 *      attached to that tag."
 *
 *   2. Node's auto-quoting under `shell:true` is naive — it doesn't
 *      escape cmd.exe metacharacters (`& | < > ^ ( ) %`). A prompt
 *      containing `> file.txt` would attempt I/O redirection.
 *
 * Fix
 * ---
 * Build the cmd.exe command line ourselves and use Node's
 * `windowsVerbatimArguments: true` flag to bypass automatic re-escaping.
 * Then quote each argument per the Windows CommandLineToArgvW rules
 * AND escape cmd.exe metacharacters with `^`. Newlines inside a
 * properly-quoted region survive cmd.exe's tokenizer.
 *
 * This is the canonical approach used by `cross-spawn` and similar
 * cross-platform-spawn libraries. Node 20+ requires either `shell:true`
 * OR `windowsVerbatimArguments:true` to spawn `.cmd`/`.bat` files
 * (CVE-2024-27980); we use the latter.
 *
 * Public API
 * ----------
 * `isWindowsShim(commandPath)` — returns true on win32 if the path
 * ends in `.cmd` or `.bat`.
 *
 * `wrapForCmdShim(commandPath, args)` — returns
 * `{ command, args, options }` ready to pass to `child_process.spawn`.
 * The caller still merges its own spawn options (cwd, env, stdio).
 */
/**
 * Detect a Windows .cmd / .bat shim. Callers gate the wrap on this so
 * the non-Windows / non-shim path stays untouched.
 */
declare function isWindowsShim(commandPath: unknown): boolean;
/**
 * Quote an argument per CommandLineToArgvW conventions so it round-trips
 * through CreateProcess. Then escape cmd.exe metacharacters so the
 * cmd.exe /c parser doesn't interpret them as redirections / pipes.
 *
 * Algorithm:
 *   - Empty string → `""`
 *   - No spaces, tabs, newlines, or quotes → return as-is (no quoting
 *     needed, fast path).
 *   - Else: Walk the string. Every `"` becomes `\"`. Trailing
 *     backslashes before a `"` (or end-of-string before the closing
 *     quote) get doubled. Wrap the whole thing in `"..."`.
 *   - Finally, escape cmd.exe metacharacters with `^`. We do this
 *     AFTER the argv-quoting because the metachars must be escaped
 *     wherever they appear, including inside quoted regions (cmd.exe
 *     interprets metachars even inside double quotes when it's parsing
 *     for special handling like `&` chaining).
 */
declare function _quoteArg(arg: string): string;
/**
 * Wrap a `.cmd`/`.bat` invocation so spawn() can run it without
 * shell:true argv munging. Returns `{ command, args, options }` —
 * caller spreads `options` into its own spawn opts:
 *
 *   const wrapped = wrapForCmdShim(this.codexPath, args);
 *   spawn(wrapped.command, wrapped.args, { ...spawnOpts, ...wrapped.options });
 *
 * The function:
 *   1. Collapses newlines in each arg to spaces (cmd.exe truncates
 *      multi-line command lines at the first newline regardless of
 *      quoting).
 *   2. Quotes each arg per CommandLineToArgvW + cmd.exe metachar
 *      rules so spaces, quotes, and shell-meta don't corrupt the
 *      child's argv.
 *   3. Wraps the whole command line in an outer pair of quotes (the
 *      `/d /s /c` double-wrap trick) so a quoted argv0 path with
 *      spaces survives.
 *   4. Sets windowsVerbatimArguments so Node doesn't re-escape the
 *      command line we just carefully constructed.
 */
declare function wrapForCmdShim(commandPath: string, args: string[]): {
    command: string;
    args: string[];
    options: {
        windowsVerbatimArguments: boolean;
    };
};
export { isWindowsShim, wrapForCmdShim, _quoteArg, };

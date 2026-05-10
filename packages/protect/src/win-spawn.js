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

const path = require("path");

/**
 * Detect a Windows .cmd / .bat shim. Callers gate the wrap on this so
 * the non-Windows / non-shim path stays untouched.
 */
function isWindowsShim(commandPath) {
  if (!commandPath || typeof commandPath !== "string") return false;
  if (process.platform !== "win32") return false;
  return /\.(cmd|bat)$/i.test(commandPath);
}

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
function _quoteArg(arg) {
  if (arg === "") return '""';

  let argvQuoted;
  if (!/[\s"]/.test(arg)) {
    argvQuoted = arg;
  } else {
    let inner = "";
    let i = 0;
    while (i < arg.length) {
      const c = arg[i];
      if (c === "\\") {
        let bs = 0;
        while (i < arg.length && arg[i] === "\\") {
          bs++;
          i++;
        }
        // If next char is a quote OR we're at end-of-string, the
        // closing wrapper-quote will treat these backslashes as
        // escapes. Double them so the parser sees the literal count.
        if (i === arg.length) {
          inner += "\\".repeat(bs * 2);
        } else if (arg[i] === '"') {
          inner += "\\".repeat(bs * 2) + '\\"';
          i++;
        } else {
          inner += "\\".repeat(bs);
        }
      } else if (c === '"') {
        inner += '\\"';
        i++;
      } else {
        inner += c;
        i++;
      }
    }
    argvQuoted = '"' + inner + '"';
  }

  // Escape cmd.exe metacharacters. Done AFTER argv-quoting because
  // cmd.exe scans the entire command line before any program receives
  // argv; a `>` even inside our quoted region could be misinterpreted
  // depending on cmd.exe's mood. Escaping with `^` is unconditionally
  // safe for `&`, `|`, `<`, `>`, `^`, `(`, `)`.
  //
  // KNOWN LIMITATION (V13H-4): caret-escape does NOT reliably suppress
  // cmd.exe's `%VAR%` variable expansion. cmd.exe's `%`-pass runs
  // BEFORE caret-handling, so `^%PATH^%` still expands to the value
  // of `PATH` rather than passing the literal `%PATH%` text through.
  // Same caveat for delayed-expansion `!VAR!` when delayed expansion
  // is enabled in the user's cmd.exe environment.
  //
  // Real-world impact: a user prompt that says literally
  // `please print %USERNAME%` will reach the CLI as
  // `please print <expanded-username>` rather than the literal text.
  // This is a Windows-cmd.exe constraint, not a Gryphon bug — every
  // tool that wraps cmd.exe shims (cross-spawn, npm, etc.) has the
  // same caveat. The robust workarounds (set quote-mode +
  // setlocal/EnableDelayedExpansion, or insert a literal `^` mid-name
  // to break the expansion match) each introduce their own foot-guns
  // (the latter changes the user's literal text) so we accept this
  // trade-off and document it. If a future user hits this, the fix
  // is to pipe the prompt via stdin instead of argv on Windows.
  return argvQuoted.replace(/[&|<>^()%!]/g, "^$&");
}

/**
 * Collapse all newlines in an argument to single spaces. cmd.exe's
 * `/c` parser treats unquoted newlines as command terminators and
 * even quoted newlines are unreliable (they survive in some shells
 * but not others, version-dependent). Rather than try to outsmart
 * cmd.exe, we lossy-fold multi-line argv args to a single line
 * before they reach the command line.
 *
 * For Gryphon's [gryphon-context] block this is fine: the block is
 * a sequence of `key: value` lines plus opening/closing tags. With
 * newlines collapsed to spaces, an LLM still parses the structure
 * unambiguously: tags are sentinels, `key:` colons separate fields,
 * value strings are JSON-quoted so spaces inside values are clear.
 *
 * This degrades the prefix from "pretty multi-line" to "single-line
 * compact" on Windows only. The macOS/Linux POSIX spawn path keeps
 * the original multi-line form.
 */
function _collapseNewlines(arg) {
  if (typeof arg !== "string") return arg;
  // Match \r\n (Windows), \n (Unix), and \r (legacy Mac) — collapse
  // each run of whitespace that contains a newline to a single
  // space. Standalone spaces/tabs without newlines are preserved.
  return arg.replace(/[ \t]*(?:\r\n|\r|\n)[ \t]*/g, " ");
}

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
function wrapForCmdShim(commandPath, args) {
  // Step 1: collapse newlines BEFORE quoting so the whole pipeline
  // works on a guaranteed single-line input.
  const safeArgs = args.map(_collapseNewlines);

  // Step 2 & 3: wrap argv0 (codex.cmd path) in quotes so a path
  // with spaces (C:\Program Files\...) tokenizes correctly.
  const quotedCmd = '"' + commandPath.replace(/"/g, '\\"') + '"';
  const quotedArgs = safeArgs.map(_quoteArg).join(" ");
  // Outer wrap: `cmd.exe /d /s /c "<line>"` — /s + outer quotes is
  // the canonical pattern from cmd.exe /? documentation that keeps
  // both an argv0-with-spaces and the quoted args parsed correctly.
  const cmdLine = `"${quotedCmd} ${quotedArgs}"`;

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", cmdLine],
    options: {
      windowsVerbatimArguments: true,
    },
  };
}

module.exports = {
  isWindowsShim,
  wrapForCmdShim,
  // Exported for unit tests.
  _quoteArg,
};

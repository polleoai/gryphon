/**
 * win-spawn helper tests.
 *
 * Exercises the argument-quoting logic in isolation. The actual
 * spawn behaviour is platform-dependent and tested manually on a
 * Windows VM; here we just lock in the quoting algorithm so future
 * regressions surface in CI.
 */

const test = require("node:test");
const assert = require("node:assert");
const { _quoteArg, isWindowsShim, wrapForCmdShim } = require("../src/win-spawn");

test("win-spawn: empty arg becomes empty quoted pair", () => {
  assert.strictEqual(_quoteArg(""), '""');
});

test("win-spawn: simple word passes through unchanged (no quoting needed)", () => {
  assert.strictEqual(_quoteArg("hello"), "hello");
});

test("win-spawn: arg with space gets wrapped in quotes", () => {
  assert.strictEqual(_quoteArg("hello world"), '"hello world"');
});

test("win-spawn: embedded double-quote becomes \\\"", () => {
  // Input:  hello "world"
  // Want:   "hello \"world\""
  const out = _quoteArg('hello "world"');
  assert.strictEqual(out, '"hello \\"world\\""');
});

test("win-spawn: trailing backslashes before close-quote get doubled", () => {
  // Input:  C:\path\
  // Want:   "C:\path\\" (the inner trailing \ is doubled because it
  //         immediately precedes the wrapper close-quote)
  // Note our test arg has a space to force wrapping.
  const out = _quoteArg("a b\\");
  // wrapper-quote → "a b\\" — the trailing single backslash gets
  // doubled so CommandLineToArgvW's parser doesn't treat it as
  // escaping the close-quote.
  assert.strictEqual(out, '"a b\\\\"');
});

test("win-spawn: _quoteArg preserves newlines in raw inputs (collapsing happens at wrapForCmdShim layer)", () => {
  // _quoteArg itself does NOT collapse newlines — that's the
  // wrapper's job. _quoteArg is a pure CommandLineToArgvW quoter,
  // so it preserves whatever bytes it's given. The newline-collapse
  // step lives in wrapForCmdShim() so we keep the layers separable
  // (testable in isolation, reusable in any future spawn surface).
  const ctx = "[gryphon-context]\nactive_file: \"foo.md\"\n[/gryphon-context]";
  const out = _quoteArg(ctx);
  assert.match(out, /^".*"$/s, "result must be wrapped in double-quotes");
  assert.ok(out.includes("\n"), "_quoteArg preserves newlines verbatim (caller is responsible for collapse)");
  assert.ok(out.includes('\\"foo.md\\"'), "embedded quotes must be backslash-escaped");
});

test("win-spawn: cmd.exe metacharacters get caret-escaped", () => {
  // Single-token arg with `&` — no spaces, but `&` triggers the
  // metachar escape pass.
  assert.strictEqual(_quoteArg("a&b"), "a^&b");
  // Inside a quoted region too — caret applies after wrap-quoting.
  assert.strictEqual(_quoteArg("foo & bar"), '"foo ^& bar"');
});

test("win-spawn: percent + bang both metachar-escaped", () => {
  // % and ! are cmd.exe variable expansions; quoting alone won't
  // suppress them, only ^-escape does.
  assert.ok(_quoteArg("100%").includes("^%"));
  assert.ok(_quoteArg("hello!world").includes("^!"));
});

test("win-spawn: isWindowsShim returns false on non-win32", () => {
  // We can't easily fake process.platform inside a single test, but
  // we can at least verify the input filter works on the host
  // platform — empty / non-string returns false unconditionally.
  assert.strictEqual(isWindowsShim(""), false);
  assert.strictEqual(isWindowsShim(null), false);
  assert.strictEqual(isWindowsShim(undefined), false);
  assert.strictEqual(isWindowsShim({}), false);
});

test("win-spawn: wrapForCmdShim builds a cmd.exe /d /s /c invocation", () => {
  const wrapped = wrapForCmdShim("C:\\Users\\you\\codex.cmd", ["exec", "--json", "hello world"]);
  assert.strictEqual(wrapped.command, "cmd.exe");
  assert.deepStrictEqual(wrapped.args.slice(0, 3), ["/d", "/s", "/c"]);
  // The 4th positional is the assembled command line.
  const cmdLine = wrapped.args[3];
  assert.ok(cmdLine.startsWith('"'), "command line must be outer-double-quoted");
  assert.ok(cmdLine.endsWith('"'), "command line must end with the outer quote");
  assert.ok(cmdLine.includes('codex.cmd'), "must include the original command path");
  assert.ok(cmdLine.includes('"hello world"'), "spaces in args must wrap-quote");
  // windowsVerbatimArguments must be set so Node doesn't re-escape.
  assert.strictEqual(wrapped.options.windowsVerbatimArguments, true);
});

test("win-spawn: wrapForCmdShim collapses newlines but preserves all content", () => {
  // The regression we're guarding against — pre-fix, cmd.exe was
  // terminating the command line at the first newline so Codex
  // received only "[gryphon-context]" and reported "no context
  // attached." With the newline-collapse, every key:value pair AND
  // the trailing user prompt make it through intact, just on a
  // single line. LLMs parse the structured block fine without
  // newlines because the tags + colons are unambiguous.
  const promptArg = "[gryphon-context]\nactive_file: \"x.md\"\nactive_folder: \"docs\"\n[/gryphon-context]\n\nsummarize the current page";
  const wrapped = wrapForCmdShim("C:\\codex.cmd", ["exec", "--", promptArg]);
  const cmdLine = wrapped.args[3];
  assert.ok(!cmdLine.includes("\n"), "newlines must be collapsed (cmd.exe /c truncates at \\n regardless of quoting)");
  assert.ok(cmdLine.includes("[gryphon-context]"), "context opening tag must be present");
  assert.ok(cmdLine.includes("[/gryphon-context]"), "context closing tag must be present");
  assert.ok(cmdLine.includes("active_file: \\\"x.md\\\""), "active_file key:value pair must reach Codex");
  assert.ok(cmdLine.includes("active_folder: \\\"docs\\\""), "active_folder key:value pair must reach Codex");
  assert.ok(cmdLine.includes("summarize the current page"), "trailing user prompt must follow the context block on the same line");
});

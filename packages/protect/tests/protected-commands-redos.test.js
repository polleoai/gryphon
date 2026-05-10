/**
 * ReDoS-safety check for DEFAULT_PROTECTED_COMMANDS regexes.
 *
 * Each shipped pattern is compiled and run against pathological
 * inputs (long repeats of trigger characters that often cause
 * catastrophic backtracking on poorly-written regex). A pattern
 * that takes more than REDOS_BUDGET_MS to match-or-not on input
 * up to MAX_INPUT_BYTES is failed with the offending pattern
 * pinpointed, so we don't ship a regex that lets a model freeze
 * a hook (PreToolUse runs the scan inside our 285s deadline; a
 * single hang would block all tool calls).
 *
 * The budget is generous (50ms) — these checks run at hook time
 * on the user's machine, and we'd rather catch any pattern with
 * polynomial-or-worse behavior even if it would never quite reach
 * a real timeout under typical input sizes. Real CC tool inputs
 * are bounded in practice, but a malicious model could attempt
 * to craft one that maximises backtracking; the budget here
 * fails before that becomes possible.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");

const { DEFAULT_PROTECTED_COMMANDS } = require("../src/constants");

const REDOS_BUDGET_MS = 50;
const MAX_INPUT_BYTES = 64 * 1024;

// Adversarial inputs designed to trigger backtracking in patterns
// that lean on `.*`, `\s*`, alternation, or unbounded character
// classes. Mix of:
//   - long repeats of common metachar-adjacent chars (`|`, `\`, ` `)
//   - bait sequences that "almost match" trigger words
//   - mixed alphanumeric to defeat naive prefix shortcuts
function buildAdversarialInputs() {
  const repeat = (s, n) => s.repeat(n);
  return [
    "",
    " ".repeat(MAX_INPUT_BYTES),
    "|".repeat(8192),
    repeat("a |", 4096),
    repeat("rm -", 4096),
    repeat("Remove-Item ", 2048),
    repeat("|iex|", 4096),
    repeat("curl ", 4096) + "| bash",
    repeat("|", 8192) + "bash",
    repeat("/", 8192) + "bash",
    repeat("\\\\", 4096),
    repeat("$env:", 4096),
    repeat("HKLM:", 4096) + "Set-ItemProperty",
    // Long whitespace runs near alternation
    repeat(" \t", 4096) + "rm -rf /",
    // Repeated near-misses for the "shell -c" pattern
    repeat("bash- ", 2048),
    // Repeated near-misses for the script-interpreter pattern
    repeat("python ", 2048) + "-c 'x'",
  ];
}

const ADVERSARIAL_INPUTS = buildAdversarialInputs();

test("every DEFAULT_PROTECTED_COMMANDS regex compiles", () => {
  for (const entry of DEFAULT_PROTECTED_COMMANDS) {
    const pattern = typeof entry === "string" ? entry : entry.pattern;
    assert.doesNotThrow(
      () => new RegExp(pattern, "i"),
      `pattern failed to compile: ${pattern}`,
    );
  }
});

test(`no pattern exceeds ${REDOS_BUDGET_MS}ms on adversarial input`, () => {
  // Cap at MAX_INPUT_BYTES — real CC inputs are bounded; we don't
  // need to test megabyte payloads to surface backtracking that
  // would manifest in practice.
  const inputs = ADVERSARIAL_INPUTS.map((s) =>
    s.length > MAX_INPUT_BYTES ? s.slice(0, MAX_INPUT_BYTES) : s,
  );

  const offenders = [];
  for (const entry of DEFAULT_PROTECTED_COMMANDS) {
    const pattern = typeof entry === "string" ? entry : entry.pattern;
    const re = new RegExp(pattern, "i");
    for (const input of inputs) {
      const start = performance.now();
      // We don't care about the result, only the time. `.test()` is
      // the cheapest path; lastIndex etc. don't apply (no /g flag).
      re.test(input);
      const elapsed = performance.now() - start;
      if (elapsed > REDOS_BUDGET_MS) {
        offenders.push({
          pattern,
          inputPreview: input.slice(0, 40) + (input.length > 40 ? "..." : ""),
          inputLen: input.length,
          elapsedMs: Math.round(elapsed * 100) / 100,
        });
      }
    }
  }

  assert.equal(
    offenders.length, 0,
    `${offenders.length} pattern/input pair(s) exceeded ${REDOS_BUDGET_MS}ms:\n` +
    offenders.map((o) =>
      `  pattern=${JSON.stringify(o.pattern)} ` +
      `input(len=${o.inputLen})=${JSON.stringify(o.inputPreview)} ` +
      `elapsed=${o.elapsedMs}ms`,
    ).join("\n"),
  );
});

// Sanity: confirm the harness CAN catch a known-bad pattern. If
// this test starts failing because the catastrophic regex finishes
// fast, the engine has gotten smarter and we can tighten the
// budget. (V8's RegExp doesn't yet skip catastrophic backtracking,
// so this should reliably fail-fast as a positive control.)
test("ReDoS harness positive control — catastrophic pattern is caught", () => {
  const catastrophic = "^(a+)+$";
  const re = new RegExp(catastrophic);
  // 30 a's + b = 2^30 backtracks in the worst case — should
  // very obviously exceed the budget.
  const input = "a".repeat(30) + "b";
  const start = performance.now();
  re.test(input);
  const elapsed = performance.now() - start;
  assert.ok(
    elapsed > REDOS_BUDGET_MS,
    `positive control unexpectedly fast (${elapsed}ms) — V8 may have ` +
    `added backtracking limits. If so, raise the budget or replace ` +
    `with a worse pathological pattern.`,
  );
});

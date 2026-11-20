/**
 * Issue #53 (security review, REL-2.13.1): Claude Code's cost counter
 * restarts at 0 in every new CLI process. A budgeted call made after the
 * process was replaced (abort, crash, supersede) must still be measured by
 * what THIS call spent — not by the new process's total minus the old
 * process's total, which reads low (even negative) and let a $0.90 call
 * through a $0.50 cap.
 *
 * Runs the real spawn path against a fake CLI (tests/_fixtures).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");

const FAKE = path.join(__dirname, "_fixtures", "fake-claude-cost.js");

test("claude-code: a budgeted call after a CLI respawn is measured by its own spend", { skip: process.platform === "win32" }, async () => {
  fs.chmodSync(FAKE, 0o755);
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-budget-"));
  const p = new ClaudeCodeProvider(FAKE, vault, {});
  try {
    // Process A: five unbudgeted turns → session total $4.50.
    for (let i = 0; i < 5; i++) await p.send("hi");
    p.abort(); // e.g. a consumer's timeout / AbortSignal

    // Process B: this call really costs $0.90, over a $0.50 cap.
    await assert.rejects(p.send("hi", { maxUsdBudget: 0.5 }), (e) => {
      assert.equal(e.name, "BudgetExceededError");
      assert.ok(e.spent >= 0.5, `spent=${e.spent}`);
      return true;
    });

    // And a call under its cap after a respawn still passes.
    p.abort();
    const r = await p.send("hi", { maxUsdBudget: 1 });
    assert.equal(r.text, "ok");
  } finally {
    try { p.abort(); } catch { /* best effort */ }
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

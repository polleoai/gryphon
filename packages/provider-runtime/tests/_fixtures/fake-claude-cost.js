#!/usr/bin/env node
// Fake Claude Code CLI for budget tests (issue #53). Like a real fresh
// process, each process starts its own cost counter at 0 and reports the
// running total as total_cost_usd. Every prompt costs $0.90.
if (process.argv.includes("--version")) { console.log("9.9.9 (Claude Code)"); process.exit(0); }
let total = 0;
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    buf = buf.slice(i + 1);
    total += 0.9;
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-5" }) + "\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok", total_cost_usd: total, session_id: "s1", duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } }) + "\n");
  }
});

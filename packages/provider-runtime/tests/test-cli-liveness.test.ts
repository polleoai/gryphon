/**
 * Issue #19 — hardened test-cli.ts liveness checks (gemini-cli, codex-cli,
 * antigravity-cli). `--version` alone never proves the CLI can serve a
 * completion (a CLI can be UNSUPPORTED_CLIENT-deprecated, or logged out,
 * and still answer `--version` fine) — these tests exercise the real-prompt
 * assertion against a fake shell-script CLI so no live spawn/network/API
 * cost is incurred, while still proving the parser + pass/fail logic.
 *
 * Fake CLIs are POSIX shell scripts (mirrors binary-resolution.test.ts's
 * `fakeCli` helper) that print canned JSONL to stdout/stderr and exit —
 * gated to POSIX since Windows shims need different scripting.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const isWindows = process.platform === "win32";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-testcli-"));
}

// Writes a POSIX shell script that ignores argv, prints `stdout` to
// stdout and `stderr` to stderr (one line each JSONL entry already
// newline-joined by the caller), then exits with `code`.
function fakeCliScript(dir: string, name: string, { stdout = "", stderr = "", code = 0 } = {}): string {
  const p = path.join(dir, name);
  const body = [
    "#!/bin/sh",
    stdout ? `cat <<'GRYPHON_EOF_OUT'\n${stdout}\nGRYPHON_EOF_OUT` : "",
    stderr ? `cat <<'GRYPHON_EOF_ERR' 1>&2\n${stderr}\nGRYPHON_EOF_ERR` : "",
    `exit ${code}`,
    "",
  ].join("\n");
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}

// ─────────────────────────────────────────────────────────────────
// gemini-cli/test-cli.ts
// ─────────────────────────────────────────────────────────────────

test("gemini-cli testCli: no path configured", async () => {
  const { testCli } = require("../src/providers/gemini-cli/test-cli");
  const r: any = await testCli("");
  assert.equal(r.ok, false);
  assert.match(r.message, /No Gemini CLI path configured/);
});

test("gemini-cli testCli: real completion (stream-json assistant message) → ok:true", { skip: isWindows }, async () => {
  const dir = tmpDir();
  const bin = fakeCliScript(dir, "gemini", {
    stdout: [
      JSON.stringify({ type: "init", session_id: "s1" }),
      JSON.stringify({ type: "message", role: "assistant", content: "OK" }),
      JSON.stringify({ type: "result", status: "success", stats: {} }),
    ].join("\n"),
    code: 0,
  });
  const { testCli } = require("../src/providers/gemini-cli/test-cli");
  const r: any = await testCli(bin);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /real completion/);
});

test("gemini-cli testCli: exit 0 + empty stdout → ok:false (the exact issue #19 failure mode)", { skip: isWindows }, async () => {
  const dir = tmpDir();
  const bin = fakeCliScript(dir, "gemini", { stdout: "", stderr: "", code: 0 });
  const { testCli } = require("../src/providers/gemini-cli/test-cli");
  const r: any = await testCli(bin);
  assert.equal(r.ok, false);
  assert.match(r.message, /no completion text/i);
});

test("gemini-cli testCli: UNSUPPORTED_CLIENT on stderr → ok:false with the specific deprecation message", { skip: isWindows }, async () => {
  const dir = tmpDir();
  const bin = fakeCliScript(dir, "gemini", {
    stdout: "",
    stderr: "reasonCode: 'UNSUPPORTED_CLIENT', reasonMessage: 'migrate to Antigravity'",
    code: 0,
  });
  const { testCli } = require("../src/providers/gemini-cli/test-cli");
  const r: any = await testCli(bin);
  assert.equal(r.ok, false);
  assert.match(r.message, /Antigravity/);
  assert.match(r.message, /no longer supported/i);
});

// ─────────────────────────────────────────────────────────────────
// codex-cli/test-cli.ts
// ─────────────────────────────────────────────────────────────────

test("codex-cli testCli: no path configured", async () => {
  const { testCli } = require("../src/providers/codex-cli/test-cli");
  const r: any = await testCli(null);
  assert.equal(r.ok, false);
  assert.match(r.message, /No Codex CLI path configured/);
});

test("codex-cli testCli: real completion (item.completed agent_message) → ok:true", { skip: isWindows }, async () => {
  const dir = tmpDir();
  const bin = fakeCliScript(dir, "codex", {
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n"),
    code: 0,
  });
  const { testCli } = require("../src/providers/codex-cli/test-cli");
  const r: any = await testCli(bin);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /real completion/);
});

test("codex-cli testCli: exit 0 + empty stdout → ok:false", { skip: isWindows }, async () => {
  const dir = tmpDir();
  const bin = fakeCliScript(dir, "codex", { stdout: "", code: 0 });
  const { testCli } = require("../src/providers/codex-cli/test-cli");
  const r: any = await testCli(bin);
  assert.equal(r.ok, false);
  assert.match(r.message, /no completion text/i);
});

test("codex-cli testCli: not-logged-in stderr → ok:false with actionable login hint", { skip: isWindows }, async () => {
  const dir = tmpDir();
  const bin = fakeCliScript(dir, "codex", { stdout: "", stderr: "Error: not logged in", code: 1 });
  const { testCli } = require("../src/providers/codex-cli/test-cli");
  const r: any = await testCli(bin);
  assert.equal(r.ok, false);
  assert.match(r.message, /codex login/);
});

// ─────────────────────────────────────────────────────────────────
// antigravity-cli/test-cli.ts
// ─────────────────────────────────────────────────────────────────

test("antigravity-cli testCli: no path configured", async () => {
  const { testCli } = require("../src/providers/antigravity-cli/test-cli");
  const r: any = await testCli(undefined);
  assert.equal(r.ok, false);
  assert.match(r.message, /No Antigravity CLI path configured/);
});

test("antigravity-cli testCli: real completion (stream-json, real event shape) → ok:true", { skip: isWindows }, async () => {
  const dir = tmpDir();
  // REAL wire shape, verified live against agy v1.1.8 (see
  // antigravity-cli.ts's header) — not gemini-cli's flat `type` shape.
  const bin = fakeCliScript(dir, "agy", {
    stdout: [
      JSON.stringify({ event: "init", conversation_id: "s1", init: { cwd: "/tmp", tools: [], permission_mode: "always-proceed" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "OK" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "\n", usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 13 } } }),
      JSON.stringify({ event: "result", result: { conversation_id: "s1", status: "SUCCESS", response: "OK\n", duration_seconds: 0.5, num_turns: 1, usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 13 } } }),
    ].join("\n"),
    code: 0,
  });
  const { testCli } = require("../src/providers/antigravity-cli/test-cli");
  const r: any = await testCli(bin);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /real completion/);
});

test("antigravity-cli testCli: exit 0 + empty stdout → ok:false (never a silent success)", { skip: isWindows }, async () => {
  const dir = tmpDir();
  const bin = fakeCliScript(dir, "agy", { stdout: "", code: 0 });
  const { testCli } = require("../src/providers/antigravity-cli/test-cli");
  const r: any = await testCli(bin);
  assert.equal(r.ok, false);
  assert.match(r.message, /no completion text/i);
});

test("antigravity-cli testCli: not-authenticated stderr → ok:false with sign-in hint", { skip: isWindows }, async () => {
  const dir = tmpDir();
  const bin = fakeCliScript(dir, "agy", { stdout: "", stderr: "Error: not authenticated", code: 1 });
  const { testCli } = require("../src/providers/antigravity-cli/test-cli");
  const r: any = await testCli(bin);
  assert.equal(r.ok, false);
  assert.match(r.message, /sign in/i);
});

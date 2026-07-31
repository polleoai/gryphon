/**
 * Antigravity PreToolUse must FAIL CLOSED on any payload it cannot read.
 *
 * Every other CLI Gryphon supports keeps its own approval prompt, so an
 * unreadable hook payload falling through to "allow" is survivable — the CLI
 * still asks. Antigravity is the exception: the provider spawns it with
 * `--dangerously-skip-permissions` (without that flag headless `agy`
 * auto-denies every tool and the provider is unusable), which means Gryphon's
 * hook is the ONLY gate. Allowing on an unreadable payload there is not a
 * degraded check, it is no check.
 *
 * This matters most for shapes we have not seen. `agy` v1.1.8 sends
 * `{toolCall:{name,args}}`; a future version that renames those inner fields
 * would sail straight past a normalizer written against today's shape. The
 * guarantee under test is that such a payload is DENIED, loudly, rather than
 * silently executed.
 *
 * Regression: shipped allowing in v2.9.1 — a `toolCall` with drifted inner
 * fields returned {"decision":"allow"} for `rm -rf ~`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const path = require("path");

const HOOK = path.join(__dirname, "..", "..", "..", "hooks", "pretool.js");

function runHook(payload: any, dialect: string) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: {
      ...process.env,
      GRYPHON_HOOK_DIALECT: dialect,
      GRYPHON_PERMISSION_SOCKET: "/nonexistent-gryphon-test.sock",
    },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

test("antigravity: payload with no toolCall is DENIED", () => {
  const r = runHook({ conversationId: "c1", stepIdx: 3 }, "antigravity");
  assert.equal(r.decision, "deny",
    "nothing else gates this provider — an unreadable payload must not execute");
  assert.ok(r.reason && r.reason.length > 0, "the user needs to know why it was refused");
});

test("antigravity: toolCall with drifted inner field names is DENIED", () => {
  // The exact regression: name/args renamed by a future agy version.
  const r = runHook({
    toolCall: { toolName: "run_command", arguments: { CommandLine: "rm -rf ~" } },
    conversationId: "c1",
  }, "antigravity");
  assert.equal(r.decision, "deny",
    "a shape we cannot parse is exactly when we must not allow");
});

test("antigravity: a well-formed payload is still classified normally", () => {
  // Plugin unreachable here, so the expected outcome is the IPC-failure deny,
  // NOT the unparseable-payload deny — proving we did not simply deny
  // everything to pass the two tests above.
  const r = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "echo hi" } },
    conversationId: "c1",
  }, "antigravity");
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /could not reach the plugin/i,
    "must have reached the classify step, not short-circuited on parsing");
});

test("other dialects keep their existing allow-on-unrecognised behaviour", () => {
  // Claude Code / Codex / Gemini retain their own approval prompts, and
  // changing their long-standing fall-through is out of scope here.
  const r = runHook({ hook_event_name: "PreToolUse", session_id: "s1" }, "");
  assert.equal(r.hookSpecificOutput.permissionDecision, "allow",
    "unchanged for providers that still have a second line of defence");
});

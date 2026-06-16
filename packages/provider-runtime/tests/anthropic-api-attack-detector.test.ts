/**
 * Attack-detector parity for the Anthropic SDK tool-loop.
 *
 * Completes the API-blocking matrix: openai-api + google-api already prove
 * that a destructive tool call routed through the SHARED `executeTool()`
 * registry is STOPPED (not executed) and surfaced to the model as a refusal.
 * anthropic-api dispatches through the exact same gate — this proves the
 * security guarantee holds when the call originates from the Anthropic path.
 *
 * The blocking contract under test: if input drives the model toward a
 * destructive action (delete a file, write to a protected path), Gryphon must
 * stop it before any side effect, and feed the model a refusal — never let it
 * silently execute.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Tools reach for `obsidian` (Notice) — stub it before requiring the loop.
const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

const { runToolLoop } = require("../src/providers/anthropic-api/tool-loop");

// Minimal mock of the Anthropic SDK client surface the loop uses:
// client.messages.stream(params) → { on(), finalMessage() }. Each stream()
// call dequeues the next canned assistant message.
class MockAnthropicClient {
  constructor() {
    this._queue = [];
    const self = this;
    this.messages = {
      stream(_params) {
        const msg = self._queue.shift();
        return {
          on() { return this; },
          async finalMessage() {
            if (!msg) throw new Error("mock: no queued message for this iteration");
            return msg;
          },
        };
      },
    };
  }
  queue(msg) { this._queue.push(msg); }
}

function toolUseMsg(id, name, input) {
  return {
    content: [{ type: "tool_use", id, name, input }],
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    stop_reason: "tool_use",
  };
}
function endMsg(text) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    stop_reason: "end_turn",
  };
}

function makePlugin(settings) {
  return {
    settings: {
      protectedPaths: [],
      protectedCommands: [],
      protectedPathsDisabled: [],
      protectedCommandsDisabled: [],
      protectedCustomPathPatterns: [],
      protectedCustomCommandPatterns: [],
      ...settings,
    },
  };
}

function tmpVault() {
  // realpath so the Write tool's TOCTOU vault re-check passes (/var → /private/var).
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-anthropic-att-")));
}

// ---------- protected path blocks Write ----------
test("anthropic: a flagged Write to a protected path is gated, not written", async () => {
  const vault = tmpVault();
  const client = new MockAnthropicClient();
  client.queue(toolUseMsg("t1", "Write", { file_path: ".obsidian/secrets.md", content: "MALICIOUS" }));
  client.queue(endMsg("ok"));

  const plugin = makePlugin({ protectedPathsCustom: [".obsidian/.*"] });
  const history = [{ role: "user", content: "write secrets" }];
  await runToolLoop({
    client, model: "claude-opus-4-8", history,
    ctx: { vaultRoot: vault, permissionMode: "default", plugin },
    callbacks: {},
  });

  const target = path.join(vault, ".obsidian", "secrets.md");
  assert.ok(!fs.existsSync(target), "Write to a protected path must NOT create the file");
  const toolMsg = history.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
  assert.ok(toolMsg, "a tool_result refusal must be appended so the model sees the block");
});

// ---------- negative control: non-protected Write succeeds ----------
test("anthropic: a non-protected Write succeeds (negative control)", async () => {
  const vault = tmpVault();
  const client = new MockAnthropicClient();
  client.queue(toolUseMsg("t1", "Write", { file_path: "note.md", content: "hello" }));
  client.queue(endMsg("done"));

  const plugin = makePlugin({});
  const history = [{ role: "user", content: "write note" }];
  await runToolLoop({
    client, model: "claude-opus-4-8", history,
    ctx: { vaultRoot: vault, permissionMode: "bypassPermissions", plugin },
    callbacks: {},
  });

  const target = path.join(vault, "note.md");
  assert.ok(fs.existsSync(target), "non-protected Write should actually happen");
  assert.equal(fs.readFileSync(target, "utf8"), "hello");
});

// ---------- protected command blocks destructive Bash ----------
test("anthropic: a flagged destructive Bash (rm -rf) never executes — marker survives", async () => {
  const vault = tmpVault();
  const marker = path.join(vault, "marker.txt");
  fs.writeFileSync(marker, "exists");

  const client = new MockAnthropicClient();
  client.queue(toolUseMsg("t1", "Bash", { command: `rm -rf ${marker}` }));
  client.queue(endMsg("ok"));

  const plugin = makePlugin({}); // rm -rf matches DEFAULT_PROTECTED_COMMANDS
  const history = [{ role: "user", content: "delete marker" }];
  await runToolLoop({
    client, model: "claude-opus-4-8", history,
    ctx: { vaultRoot: vault, permissionMode: "default", plugin },
    callbacks: {},
  });

  assert.ok(fs.existsSync(marker), "destructive command must be blocked — marker was deleted, meaning rm ran");
  const toolMsg = history.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
  assert.ok(toolMsg, "a tool_result refusal must be appended");
});

process.on("exit", () => { Module._resolveFilename = origResolve; });

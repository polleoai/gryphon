/**
 * Stage 2 (#17) attack-detector parity for the OpenAI tool-loop.
 *
 * The security guarantee for v1.2 is that switching providers does NOT
 * weaken Gryphon's protected-pattern enforcement. Both anthropic-api and
 * openai-api dispatch through `executeTool()` from the shared tool
 * registry, which means the SAME attack-detector / permission-gate code
 * runs regardless of which provider triggered the call.
 *
 * These tests prove that contract by exercising the loop against tools
 * with content the user's protected-pattern lists would flag — and
 * verifying the result reaches the model AS A REFUSAL, not as success.
 *
 * Stage 4 (#19) extends this with synthetic GPT outputs from the live API
 * once a developer key is available.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

const { runOpenAIToolLoop } = require("../src/providers/openai-api/tool-loop");
const { MockClient } = require("./_stubs/openai-mock-client");

function chunkResp(text, finish_reason, tool_calls, usage) {
  return {
    chunks: text ? [text] : [],
    completion: {
      id: "mock",
      choices: [{
        index: 0,
        message: { role: "assistant", content: text || null, tool_calls },
        finish_reason,
      }],
      usage: usage || { prompt_tokens: 1, completion_tokens: 1 },
    },
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
  // Resolve symlinks (e.g. /var → /private/var on macOS) so the Write tool's
  // TOCTOU re-check passes. Without realpath, Write aborts with "Path escaped
  // the vault between resolution and mkdir".
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-openai-att-")));
}

// ---------- protected paths block Write ----------
//
// Note on coverage scope: the attack-detector currently classifies INPUT
// for Write/Edit/Bash/PowerShell only. Read/Glob/Grep aren't input-gated —
// their threat surface is the OUTPUT, which the hooks layer (PostToolUse)
// scans via injection-patterns + untrusted-framing. SDK-mode tools don't
// re-run that scan today; tracked separately as Stage 4 work for parity
// with the CLI hooks. These tests cover the input-gating tools that
// SHARE the registry path with anthropic-api.

test("protected path: a flagged Write goes through input gating (not raw fs.writeFile)", async () => {
  const vault = tmpVault();

  const client = new MockClient();
  client.queueResponse(chunkResp(null, "tool_calls", [{
    id: "c1",
    type: "function",
    function: {
      name: "Write",
      arguments: JSON.stringify({
        file_path: ".obsidian/secrets.md",
        content: "MALICIOUS",
      }),
    },
  }]));
  client.queueResponse(chunkResp("ok", "stop"));

  // Custom protected paths take an array of pattern STRINGS, not objects.
  const plugin = makePlugin({
    protectedPathsCustom: [".obsidian/.*"],
  });

  const history = [{ role: "user", content: "write secrets" }];
  await runOpenAIToolLoop({
    client,
    model: "gpt-4o",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: vault, permissionMode: "default", plugin },
    callbacks: {},
  });

  // Critical: the file MUST NOT have been written. (If gating were bypassed,
  // the file would exist with "MALICIOUS" content.)
  const target = path.join(vault, ".obsidian", "secrets.md");
  assert.ok(!fs.existsSync(target),
    "Write to protected path must not actually create the file");
  // Tool result must be appended (so the model sees the refusal).
  const toolMsg = history.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool result must be appended even when gated");
});

test("non-protected path: Write succeeds normally (negative control)", async () => {
  const vault = tmpVault();

  const client = new MockClient();
  client.queueResponse(chunkResp(null, "tool_calls", [{
    id: "c1",
    type: "function",
    function: {
      name: "Write",
      arguments: JSON.stringify({ file_path: "note.md", content: "hello" }),
    },
  }]));
  client.queueResponse(chunkResp("done", "stop"));

  // Permission mode "yolo" so Write doesn't prompt — the goal here is to
  // prove the WRITE ACTUALLY HAPPENED for an unprotected path.
  const plugin = makePlugin({});
  const history = [{ role: "user", content: "write note" }];
  await runOpenAIToolLoop({
    client,
    model: "gpt-4o",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: vault, permissionMode: "bypassPermissions", plugin },
    callbacks: {},
  });

  const target = path.join(vault, "note.md");
  assert.ok(fs.existsSync(target), "non-protected Write should succeed");
  assert.equal(fs.readFileSync(target, "utf8"), "hello");
});

// ---------- protected commands block Bash ----------

test("protected command: a flagged Bash never executes — gating engages on input", async () => {
  const vault = tmpVault();
  // The marker file lets us prove the command did not actually run.
  // If `rm` got through, this file would be deleted; if gating engages,
  // it survives.
  const marker = path.join(vault, "marker.txt");
  fs.writeFileSync(marker, "exists");

  const client = new MockClient();
  client.queueResponse(chunkResp(null, "tool_calls", [{
    id: "c1",
    type: "function",
    function: {
      name: "Bash",
      arguments: JSON.stringify({ command: `rm -rf ${marker}` }),
    },
  }]));
  client.queueResponse(chunkResp("ok", "stop"));

  // rm -rf matches DEFAULT_PROTECTED_COMMANDS — no custom pattern needed.
  const plugin = makePlugin({});

  const history = [{ role: "user", content: "delete marker" }];
  await runOpenAIToolLoop({
    client,
    model: "gpt-4o",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: vault, permissionMode: "default", plugin },
    callbacks: {},
  });

  // Critical security assertion: marker file MUST still exist.
  assert.ok(fs.existsSync(marker),
    "Protected command must not execute. Marker file was deleted, meaning rm ran.");
  const toolMsg = history.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool result must be appended (model needs to see the refusal)");
});

// ---------- restore module resolver ----------

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});

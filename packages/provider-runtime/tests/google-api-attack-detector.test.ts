/**
 * Stage 3 (#18) attack-detector parity for the Gemini tool-loop.
 *
 * Mirror of openai-api-attack-detector. The security guarantee for v1.2 is
 * that switching providers does NOT weaken Gryphon's protected-pattern
 * enforcement. Both openai-api and google-api dispatch through the shared
 * `executeTool()` registry, so the SAME attack-detector / permission-gate
 * code runs regardless of provider.
 *
 * Coverage scope: input-gating tools (Write/Edit/Bash) only. Read/Glob/Grep
 * are NOT input-gated by attack-detector — their threat surface is OUTPUT,
 * which the hooks layer scans (Stage 4 work for SDK-mode parity).
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

const { runGeminiToolLoop } = require("../src/providers/google-api/tool-loop");
const { MockClient, textChunk } = require("./_stubs/gemini-mock-client");

function tmpVault() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-gemini-att-")));
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

function functionCallTurn(name, args, id) {
  const fc = { name, args };
  if (id) fc.id = id;
  return {
    chunks: [{
      candidates: [{
        content: { parts: [{ functionCall: fc }] },
        finishReason: "STOP",
      }],
    }],
  };
}

// ---------- protected paths block Write ----------

test("protected path: Write to flagged path goes through input gating (file not created)", async () => {
  const vault = tmpVault();

  const client = new MockClient();
  client.queueResponse(functionCallTurn("Write", {
    file_path: ".obsidian/secrets.md",
    content: "MALICIOUS",
  }));
  client.queueResponse({ chunks: [textChunk("ok", "STOP")] });

  const plugin = makePlugin({ protectedPathsCustom: [".obsidian/.*"] });

  const history = [{ role: "user", parts: [{ text: "write secrets" }] }];
  await runGeminiToolLoop({
    client,
    model: "gemini-2.5-pro",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: vault, permissionMode: "default", plugin },
    callbacks: {},
  });

  const target = path.join(vault, ".obsidian", "secrets.md");
  assert.ok(!fs.existsSync(target),
    "Write to protected path must not actually create the file");
  // Tool result must be appended (so the model sees the refusal)
  const toolTurn = history.find((c) => c.role === "user" && c.parts[0] && c.parts[0].functionResponse);
  assert.ok(toolTurn, "tool result turn must be appended even when gated");
});

test("non-protected path: Write succeeds normally (negative control)", async () => {
  const vault = tmpVault();

  const client = new MockClient();
  client.queueResponse(functionCallTurn("Write", { file_path: "note.md", content: "hello" }));
  client.queueResponse({ chunks: [textChunk("done", "STOP")] });

  const plugin = makePlugin({});
  const history = [{ role: "user", parts: [{ text: "write note" }] }];
  await runGeminiToolLoop({
    client,
    model: "gemini-2.5-pro",
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

test("protected command: flagged Bash never executes — gating engages on input", async () => {
  const vault = tmpVault();
  const marker = path.join(vault, "marker.txt");
  fs.writeFileSync(marker, "exists");

  const client = new MockClient();
  client.queueResponse(functionCallTurn("Bash", { command: `rm -rf ${marker}` }));
  client.queueResponse({ chunks: [textChunk("ok", "STOP")] });

  const plugin = makePlugin({});

  const history = [{ role: "user", parts: [{ text: "delete marker" }] }];
  await runGeminiToolLoop({
    client,
    model: "gemini-2.5-pro",
    systemPrompt: "sys",
    history,
    ctx: { vaultRoot: vault, permissionMode: "default", plugin },
    callbacks: {},
  });

  // Critical: marker must still exist (rm did NOT execute).
  assert.ok(fs.existsSync(marker),
    "Protected command must not execute. Marker file was deleted, meaning rm ran.");
  const toolTurn = history.find((c) => c.role === "user" && c.parts[0] && c.parts[0].functionResponse);
  assert.ok(toolTurn);
});

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});

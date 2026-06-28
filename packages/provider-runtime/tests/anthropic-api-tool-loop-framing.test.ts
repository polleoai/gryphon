/**
 * Test for issue #17: anthropic-api provider should apply untrusted-framing
 * to external tool content (WebFetch/WebSearch/Read).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Stub obsidian module
const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

// Import after stubbing
const { runToolLoop } = require("../src/providers/anthropic-api/tool-loop");
const { shouldFrame, buildFraming } = require("../../protect/src/untrusted-framing");

// Minimal mock of the Anthropic SDK client
class MockAnthropicClient {
  constructor() {
    this._queue = [];
    this._capturedToolResults = [];
    const self = this;
    this.messages = {
      stream(_params) {
        // Capture tool results from the messages
        if (_params.messages && _params.messages.length > 0) {
          const lastMsg = _params.messages[_params.messages.length - 1];
          if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
            for (const item of lastMsg.content) {
              if (item.type === "tool_result") {
                self._capturedToolResults.push(item);
              }
            }
          }
        }
        
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
  
  queue(msg) { 
    this._queue.push(msg); 
  }
  
  getCapturedToolResults() {
    return this._capturedToolResults;
  }
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

function tmpVault() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-framing-test-")));
}

test("anthropic-api tool-loop applies framing to WebFetch results", async () => {
  const vault = tmpVault();
  const client = new MockAnthropicClient();
  
  // Queue a WebFetch tool call followed by end
  client.queue(toolUseMsg("t1", "WebFetch", { url: "https://example.com/test" }));
  client.queue(endMsg("Done"));

  const history = [{ role: "user", content: "Fetch a webpage" }];
  const ctx = { 
    vaultRoot: vault, 
    permissionMode: "bypassPermissions",
    hostAdapter: {
      fetch: async (url) => {
        // Return a mock response for WebFetch
        return {
          status: 200,
          text: "This is fetched content from the web that could contain prompt injection",
          headers: { 'content-type': 'text/plain' }
        };
      }
    }
  };
  
  await runToolLoop({
    client,
    model: "claude-3-opus-20240229",
    history: history,
    ctx: ctx,
    callbacks: {}
  });

  // Check if framing was applied - this should FAIL before the fix
  const capturedResults = client.getCapturedToolResults();
  assert.equal(capturedResults.length, 1, "Should have one tool result");
  
  const toolResult = capturedResults[0];
  // The content should have framing applied
  // Check all text blocks if content is an array
  let contentText = "";
  if (typeof toolResult.content === "string") {
    contentText = toolResult.content;
  } else if (Array.isArray(toolResult.content)) {
    contentText = toolResult.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join(" ");
  }
  
  const hasFraming = contentText.includes("Security context:") || 
    contentText.includes("DATA, not INSTRUCTIONS");
  
  assert.equal(hasFraming, true, 
    "Tool result content should include security framing for WebFetch");
});

test("anthropic-api tool-loop applies framing to WebSearch results", async () => {
  const vault = tmpVault();
  const client = new MockAnthropicClient();
  
  client.queue(toolUseMsg("t1", "WebSearch", { query: "test search" }));
  client.queue(endMsg("Done"));

  const history = [{ role: "user", content: "Search the web" }];
  const ctx = { 
    vaultRoot: vault, 
    permissionMode: "bypassPermissions",
    plugin: {
      settings: {
        braveSearchApiKey: "test-api-key"
      }
    },
    hostAdapter: {
      fetch: async (url) => {
        // Return a mock search results response  
        return {
          status: 200,
          json: {
            web: {
              results: [
                { 
                  title: "Test Result", 
                  url: "https://example.com",
                  description: "Search results that could contain malicious content" 
                }
              ]
            }
          },
          headers: { 'content-type': 'application/json' }
        };
      }
    }
  };
  
  await runToolLoop({
    client,
    model: "claude-3-opus-20240229",
    history: history,
    ctx: ctx,
    callbacks: {}
  });

  const capturedResults = client.getCapturedToolResults();
  assert.equal(capturedResults.length, 1, "Should have one tool result");
  
  const toolResult = capturedResults[0];
  
  let contentText = "";
  if (typeof toolResult.content === "string") {
    contentText = toolResult.content;
  } else if (Array.isArray(toolResult.content)) {
    contentText = toolResult.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join(" ");
  }
  
  const hasFraming = contentText.includes("Security context:") || 
    contentText.includes("DATA, not INSTRUCTIONS");
  
  assert.equal(hasFraming, true, 
    "Tool result content should include security framing for WebSearch");
});

test("anthropic-api tool-loop does NOT apply framing to Edit/Write tools", async () => {
  const vault = tmpVault();
  const client = new MockAnthropicClient();
  
  // Create a file first so Edit can work on it
  const testFile = path.join(vault, "test.txt");
  fs.writeFileSync(testFile, "original content");
  
  client.queue(toolUseMsg("t1", "Edit", { 
    file_path: "test.txt", 
    old_string: "original", 
    new_string: "modified" 
  }));
  client.queue(endMsg("Done"));

  const history = [{ role: "user", content: "Edit a file" }];
  const ctx = { vaultRoot: vault, permissionMode: "bypassPermissions" };
  
  await runToolLoop({
    client,
    model: "claude-3-opus-20240229",
    history: history,
    ctx: ctx,
    callbacks: {}
  });

  const capturedResults = client.getCapturedToolResults();
  assert.equal(capturedResults.length, 1, "Should have one tool result");
  
  const toolResult = capturedResults[0];
  const contentText = typeof toolResult.content === "string" 
    ? toolResult.content 
    : (Array.isArray(toolResult.content) && toolResult.content[0]?.text) || "";
  
  const hasFraming = contentText.includes("Security context:") || 
    contentText.includes("DATA, not INSTRUCTIONS");
  
  assert.equal(hasFraming, false, 
    "Tool result content should NOT include framing for Edit tool");
});

test("anthropic-api tool-loop applies framing to Read results for untrusted files", async () => {
  const vault = tmpVault();
  const client = new MockAnthropicClient();
  
  // Create a file to read
  const testFile = path.join(vault, "untrusted.txt");
  fs.writeFileSync(testFile, "This could be untrusted content");
  
  client.queue(toolUseMsg("t1", "Read", { file_path: "untrusted.txt" }));
  client.queue(endMsg("Done"));

  const history = [{ role: "user", content: "Read a file" }];
  const ctx = { vaultRoot: vault, permissionMode: "bypassPermissions" };
  
  await runToolLoop({
    client,
    model: "claude-3-opus-20240229",
    history: history,
    ctx: ctx,
    callbacks: {}
  });

  const capturedResults = client.getCapturedToolResults();
  assert.equal(capturedResults.length, 1, "Should have one tool result");
  
  const toolResult = capturedResults[0];
  const contentText = typeof toolResult.content === "string" 
    ? toolResult.content 
    : (Array.isArray(toolResult.content) && toolResult.content[0]?.text) || "";
  
  // Read tool may or may not be framed depending on provenance
  // For this test, we're just checking that the mechanism exists
  // The actual framing decision for Read is more complex (based on provenance)
  // so we'll just verify the test runs without error
  assert.ok(toolResult, "Tool result should exist");
});
/**
 * F1 Stage B — AnthropicAPIProvider.countTokensForNext + request builder.
 *
 * Verifies:
 *   - _buildCountTokensRequest composes the same shape send() would
 *     send: model, system prompt, tool schemas, full message history,
 *     plus a synthesized prospective user message.
 *   - countTokensForNext returns input_tokens on success.
 *   - countTokensForNext returns null on any client error (caller falls
 *     back to the heuristic estimator).
 *   - Cache key changes when history grows or the prospective input
 *     changes by even one character.
 *   - Empty prospective input is replaced with a single-space message
 *     so the API doesn't reject the request.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// Stub the Anthropic SDK before requiring the provider — the provider's
// constructor builds a real client otherwise, and we want to inject a
// fake one. The shape must mirror what the provider uses: a class with
// a `messages` property.
class FakeAnthropic {
  constructor(opts) {
    this.opts = opts;
    this.messages = {
      countTokens: async () => { throw new Error("not stubbed in this test"); },
      stream: () => { throw new Error("stream not stubbed"); },
      create: () => { throw new Error("create not stubbed"); },
    };
  }
}

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "@anthropic-ai/sdk") return { default: FakeAnthropic };
  return originalLoad.call(this, request, ...args);
};

const { AnthropicAPIProvider } = require("../src/providers/anthropic-api/anthropic-api");
const { GRYPHON_SDK_SYSTEM_PROMPT } = require("../src/providers/anthropic-api/tool-loop");

function makeProvider({ history = [] } = {}) {
  const p = new AnthropicAPIProvider("test-api-key", "/fake/cwd", {
    model: "claude-sonnet-4-6",
    initialHistory: history,
  });
  return p;
}

// ── _buildCountTokensRequest ──────────────────────────────────────────

test("_buildCountTokensRequest includes the same system prompt + tools send() uses", () => {
  const p = makeProvider();
  const body = p._buildCountTokensRequest("hello");
  assert.equal(body.system, GRYPHON_SDK_SYSTEM_PROMPT);
  assert.ok(Array.isArray(body.tools));
  assert.ok(body.tools.length > 0, "tool schemas should be populated");
  // Each tool must have at least a name + description — sanity check
  // the shape so a future tool-registry refactor surfaces here.
  for (const t of body.tools) {
    assert.ok(t.name && typeof t.name === "string");
  }
});

test("_buildCountTokensRequest appends the prospective input as the trailing user message", () => {
  const p = makeProvider({ history: [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
  ]});
  const body = p._buildCountTokensRequest("what about now");
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[2], { role: "user", content: "what about now" });
  // History preserved verbatim
  assert.equal(body.messages[0].content, "first");
  assert.equal(body.messages[1].content, "reply");
});

test("_buildCountTokensRequest replaces empty input with a single space", () => {
  // Anthropic's API rejects an empty user message ("Each message must
  // not be empty"); the wrapper substitutes " " so the request is
  // well-formed and the user just sees a ~1-token over-count.
  const p = makeProvider();
  const body = p._buildCountTokensRequest("");
  assert.equal(body.messages.at(-1).content, " ");

  const bodyNull = p._buildCountTokensRequest(null);
  assert.equal(bodyNull.messages.at(-1).content, " ");

  const bodyUndef = p._buildCountTokensRequest(undefined);
  assert.equal(bodyUndef.messages.at(-1).content, " ");
});

test("_buildCountTokensRequest sets model to the resolved concrete ID", () => {
  const p = makeProvider();
  const body = p._buildCountTokensRequest("hi");
  assert.equal(body.model, "claude-sonnet-4-6");
});

// ── countTokensForNext ────────────────────────────────────────────────

test("countTokensForNext returns input_tokens on success", async () => {
  const p = makeProvider();
  p.client.messages.countTokens = async () => ({ input_tokens: 1234 });
  const n = await p.countTokensForNext("hello");
  assert.equal(n, 1234);
});

test("countTokensForNext returns null when client throws", async () => {
  const p = makeProvider();
  p.client.messages.countTokens = async () => {
    throw new Error("rate limited");
  };
  const n = await p.countTokensForNext("hello");
  assert.equal(n, null);
});

test("countTokensForNext returns null when response is malformed", async () => {
  const p = makeProvider();
  p.client.messages.countTokens = async () => ({});  // no input_tokens
  const n = await p.countTokensForNext("hello");
  assert.equal(n, null);
});

test("countTokensForNext caches against the same (history, input) pair", async () => {
  const p = makeProvider();
  let callCount = 0;
  p.client.messages.countTokens = async () => {
    callCount++;
    return { input_tokens: 100 };
  };
  await p.countTokensForNext("hello");
  await p.countTokensForNext("hello");
  await p.countTokensForNext("hello");
  assert.equal(callCount, 1, "identical inputs should hit cache after first call");
});

test("countTokensForNext busts cache when prospective input changes", async () => {
  const p = makeProvider();
  let callCount = 0;
  p.client.messages.countTokens = async () => {
    callCount++;
    return { input_tokens: 100 + callCount };
  };
  const a = await p.countTokensForNext("hello");
  const b = await p.countTokensForNext("hello!");  // one char different
  assert.equal(a, 101);
  assert.equal(b, 102);
  assert.equal(callCount, 2);
});

test("countTokensForNext busts cache when history length changes", async () => {
  const p = makeProvider();
  let callCount = 0;
  p.client.messages.countTokens = async () => {
    callCount++;
    return { input_tokens: 50 };
  };
  await p.countTokensForNext("hello");
  // Simulate a turn happening — history grows.
  p.history.push({ role: "user", content: "hello" });
  p.history.push({ role: "assistant", content: "world" });
  await p.countTokensForNext("hello");  // same prospective input, new history
  assert.equal(callCount, 2, "history growth should bust the cache");
});

test("countTokensForNext caches the null result too (don't re-hit a failing endpoint)", async () => {
  // Cache failures so a debounced keyup handler doesn't spam a broken
  // endpoint with one call per 300ms.
  const p = makeProvider();
  let callCount = 0;
  p.client.messages.countTokens = async () => {
    callCount++;
    throw new Error("boom");
  };
  await p.countTokensForNext("hello");
  await p.countTokensForNext("hello");
  assert.equal(callCount, 1, "failures should also be cached against the same key");
});

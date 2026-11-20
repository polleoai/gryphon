/**
 * Issue #53 (API providers) — a budgeted call whose response carries no
 * usable usage must stop with BudgetExceededError (costUnknown: true), never
 * count as $0. Unbudgeted calls are unchanged; a known cost under budget
 * still passes.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

const { AnthropicAPIProvider } = require("../src/providers/anthropic-api/anthropic-api");
const { OpenAIProvider } = require("../src/providers/openai-api/openai-api");
const { GoogleProvider } = require("../src/providers/google-api/google-api");
const { MockClient: OpenAIMock } = require("./_stubs/openai-mock-client");
const { MockClient: GeminiMock } = require("./_stubs/gemini-mock-client");
const { BudgetExceededError } = require("../src/budget-error");

async function expectUnknownStop(promise) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, "a budgeted call with unknown cost must not succeed");
  assert.ok(err instanceof BudgetExceededError, `expected BudgetExceededError, got ${err && err.name}: ${err && err.message}`);
  assert.equal(err.costUnknown, true);
  assert.equal(err.budget, 1);
}

// ---- Anthropic ----
class FakeAnthropic {
  constructor() {
    this.messages = { countTokens: async () => { throw new Error("not stubbed"); }, stream: null };
  }
}
function anthropic(usage) {
  const p = new AnthropicAPIProvider("k", "/vault", { client: new FakeAnthropic() });
  p.client.messages.stream = () => ({
    on() { return this; },
    async finalMessage() { return { id: "m", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", usage }; },
  });
  return p;
}
const ANTHROPIC_UNKNOWN = [["no usage", undefined], ["empty usage", {}], ["NaN input_tokens", { input_tokens: NaN, output_tokens: 1 }]];
for (const [label, usage] of ANTHROPIC_UNKNOWN) {
  test(`anthropic-api: ${label} stops a budgeted call`, async () => {
    await expectUnknownStop(anthropic(usage).send("hi", { maxUsdBudget: 1 }));
  });
}
test("anthropic-api: no usage without a budget is unchanged", async () => {
  const r = await anthropic(undefined).send("hi");
  assert.equal(r.text, "Hi");
});
test("anthropic-api: known usage under budget passes", async () => {
  const r = await anthropic({ input_tokens: 10, output_tokens: 5 }).send("hi", { maxUsdBudget: 1 });
  assert.equal(r.text, "Hi");
});

// ---- OpenAI ----
function openai(usage) {
  const client = new OpenAIMock();
  client.queueResponse({
    chunks: ["Hi"],
    completion: { id: "c", choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], ...(usage === undefined ? {} : { usage }) },
  });
  return new OpenAIProvider("sk", "/vault", { client });
}
const OPENAI_UNKNOWN = [["no usage", undefined], ["empty usage", {}], ["string prompt_tokens", { prompt_tokens: "10", completion_tokens: 1 }]];
for (const [label, usage] of OPENAI_UNKNOWN) {
  test(`openai-api: ${label} stops a budgeted call`, async () => {
    await expectUnknownStop(openai(usage).send("hi", { maxUsdBudget: 1 }));
  });
}
test("openai-api: no usage without a budget is unchanged", async () => {
  const r = await openai(undefined).send("hi");
  assert.equal(r.text, "Hi");
});
test("openai-api: known usage under budget passes", async () => {
  const r = await openai({ prompt_tokens: 10, completion_tokens: 5 }).send("hi", { maxUsdBudget: 1 });
  assert.equal(r.text, "Hi");
});

// ---- Google ----
function google(usage) {
  const client = new GeminiMock();
  client.queueResponse({
    chunks: [{ candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }], ...(usage === undefined ? {} : { usageMetadata: usage }) }],
  });
  return new GoogleProvider("k", "/vault", { client });
}
const GOOGLE_UNKNOWN = [["no usageMetadata", undefined], ["empty usageMetadata", {}], ["negative promptTokenCount", { promptTokenCount: -5, candidatesTokenCount: 1 }]];
for (const [label, usage] of GOOGLE_UNKNOWN) {
  test(`google-api: ${label} stops a budgeted call`, async () => {
    await expectUnknownStop(google(usage).send("hi", { maxUsdBudget: 1 }));
  });
}
test("google-api: no usageMetadata without a budget is unchanged", async () => {
  const r = await google(undefined).send("hi");
  assert.equal(r.text, "Hi");
});
test("google-api: known usage under budget passes", async () => {
  const r = await google({ promptTokenCount: 10, candidatesTokenCount: 5 }).send("hi", { maxUsdBudget: 1 });
  assert.equal(r.text, "Hi");
});

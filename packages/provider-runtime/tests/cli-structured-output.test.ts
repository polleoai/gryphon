const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  injectSchemaHint,
  parseAndValidate,
  CliStructuredOutputError,
} = require("../src/cli-structured-output");
const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");

test("injectSchemaHint appends schema instruction with only-JSON directive", () => {
  const out = injectSchemaHint("You are helpful.", {
    name: "Action",
    schema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"] },
  });
  assert.match(out, /JSON Schema/);
  assert.match(out, /"name":\s*"Action"/);
  assert.match(out, /only.*JSON/i);   // must instruct the model to return ONLY JSON
});

test("parseAndValidate returns object on valid JSON matching schema", () => {
  const schema = { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false };
  const result = parseAndValidate('{"x": 42}', schema);
  assert.deepEqual(result, { x: 42 });
});

test("parseAndValidate throws CliStructuredOutputError(reason=parse) on malformed JSON", () => {
  const schema = { type: "object", properties: { x: { type: "integer" } } };
  try {
    parseAndValidate("not json at all", schema);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof CliStructuredOutputError);
    assert.equal(e.reason, "parse");
    assert.ok(e.lastOutput);
  }
});

test("parseAndValidate throws CliStructuredOutputError(reason=validate) on schema mismatch", () => {
  const schema = { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false };
  try {
    parseAndValidate('{"x": "not a number"}', schema);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof CliStructuredOutputError);
    assert.equal(e.reason, "validate");
  }
});

test("parseAndValidate strips ```json fence wrapper before parsing", () => {
  const schema = { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false };
  const result = parseAndValidate('```json\n{"x": 7}\n```', schema);
  assert.deepEqual(result, { x: 7 });
});

test("validator: required property missing → validate error", () => {
  const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"], additionalProperties: false };
  assert.throws(() => parseAndValidate('{"a": "hi"}', schema), { name: "CliStructuredOutputError" });
});

test("validator: enum mismatch → validate error", () => {
  const schema = { type: "object", properties: { color: { type: "string", enum: ["red", "blue"] } }, required: ["color"], additionalProperties: false };
  assert.throws(() => parseAndValidate('{"color": "green"}', schema), { name: "CliStructuredOutputError" });
});

test("validator: array items shape mismatch → validate error", () => {
  const schema = { type: "object", properties: { xs: { type: "array", items: { type: "integer" } } }, required: ["xs"], additionalProperties: false };
  assert.throws(() => parseAndValidate('{"xs": [1, "two", 3]}', schema), { name: "CliStructuredOutputError" });
});

test("validator: additionalProperties:false rejects extras", () => {
  const schema = { type: "object", properties: { a: { type: "integer" } }, required: ["a"], additionalProperties: false };
  assert.throws(() => parseAndValidate('{"a": 1, "extra": "no"}', schema), { name: "CliStructuredOutputError" });
});

test("validator: nested object schema validates deeply", () => {
  const schema = {
    type: "object",
    properties: {
      outer: {
        type: "object",
        properties: { inner: { type: "integer" } },
        required: ["inner"],
        additionalProperties: false,
      },
    },
    required: ["outer"],
    additionalProperties: false,
  };
  const ok = parseAndValidate('{"outer": {"inner": 5}}', schema);
  assert.deepEqual(ok, { outer: { inner: 5 } });
  assert.throws(() => parseAndValidate('{"outer": {"inner": "no"}}', schema), { name: "CliStructuredOutputError" });
});

test("CliStructuredOutputError instances carry the documented shape", () => {
  const e = new CliStructuredOutputError("test", { reason: "budget-exhausted", attempts: 3, lastOutput: "junk" });
  assert.equal(e.name, "CliStructuredOutputError");
  assert.equal(e.reason, "budget-exhausted");
  assert.equal(e.attempts, 3);
  assert.equal(e.lastOutput, "junk");
});

test("validator: empty-schema property entry ({}) accepts any value (does not trigger additionalProperties)", () => {
  const schema = {
    type: "object",
    properties: { meta: {} },              // {} = any value allowed
    required: ["meta"],
    additionalProperties: false,
  };
  const result = parseAndValidate('{"meta": {"anything": 1}}', schema);
  assert.deepEqual(result, { meta: { anything: 1 } });
});

test("parseAndValidate strips ```json fence with CRLF line endings", () => {
  const schema = { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false };
  const result = parseAndValidate('```json\r\n{"x": 7}\r\n```', schema);
  assert.deepEqual(result, { x: 7 });
});

test("claude-code: maxRetries: 0 throws CliStructuredOutputError immediately without spawning", async () => {
  let spawnCalls = 0;
  const provider = new ClaudeCodeProvider({
    config: { model: "claude-sonnet-4-6" },
    hostAdapter: { notify: () => {}, fetch: async () => ({}) },
    _spawnOverride: () => {
      spawnCalls++;
      return Promise.resolve({ text: "x", sessionId: "s", cost: 0, cumulativeCost: 0, contextTokens: 0 });
    },
  });
  let err = null;
  try {
    await provider.send("p", {
      structuredOutput: {
        name: "X",
        schema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"] },
        maxRetries: 0,
      },
    });
  } catch (e) { err = e; }
  assert.ok(err, "should have thrown");
  assert.equal(err.name, "CliStructuredOutputError", `expected CliStructuredOutputError, got ${err.name}`);
  assert.equal(err.reason, "budget-exhausted");
  assert.equal(spawnCalls, 0, `no spawn should happen when maxRetries=0, but got ${spawnCalls} spawn(s)`);
});

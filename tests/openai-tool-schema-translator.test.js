/**
 * Stage 2 (#17) tool-schema translator tests.
 *
 * Pure-function TDD: validates that Gryphon's Anthropic-format SCHEMA
 * (`{ name, description, input_schema }`) translates to OpenAI's
 * function-calling format (`{ type, function: { name, description,
 * parameters } }`) per the design spec table.
 *
 * Every registered tool's SCHEMA is round-tripped — if a future stage
 * adds a tool, this test catches drift in the translator without needing
 * a canned fixture for the new tool.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("node:path");

// Stub `obsidian` so files that import it (via tool-registry transitive
// imports) load cleanly under node:test.
const stubPath = require.resolve("./_stubs/obsidian.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
  if (req === "obsidian") return stubPath;
  return origResolve.call(this, req, ...args);
};

const {
  translateSchemaToOpenAI,
  translateSchemasToOpenAI,
} = require("../src/providers/openai-api/tool-schema-translator");
const { getActiveTools } = require("../src/providers/anthropic-api/tools/tool-registry");

// ---------- shape: single-schema translation ----------

test("translateSchemaToOpenAI wraps Anthropic SCHEMA in { type, function } envelope", () => {
  const anthropic = {
    name: "Read",
    description: "Read a file.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  };

  const out = translateSchemaToOpenAI(anthropic);

  assert.equal(out.type, "function");
  assert.equal(out.function.name, "Read");
  assert.equal(out.function.description, "Read a file.");
  assert.deepEqual(out.function.parameters, anthropic.input_schema);
});

test("input_schema renames to parameters (the only structural change)", () => {
  const anthropic = {
    name: "X",
    description: "x",
    input_schema: { type: "object", properties: {} },
  };
  const out = translateSchemaToOpenAI(anthropic);
  assert.ok(!("input_schema" in out.function), "input_schema must not survive");
  assert.ok("parameters" in out.function, "parameters must be present");
});

test("translator preserves nested JSON Schema bodies verbatim (no dialect rewriting for OpenAI)", () => {
  const anthropic = {
    name: "Complex",
    description: "Tool with nested schema.",
    input_schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
        },
        opts: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["read", "write"] },
            count: { type: "integer" },
          },
          required: ["mode"],
          additionalProperties: false,
        },
      },
      required: ["files"],
    },
  };
  const out = translateSchemaToOpenAI(anthropic);
  // Deep-equal — OpenAI accepts standard JSON Schema, no rewriting needed.
  assert.deepEqual(out.function.parameters, anthropic.input_schema);
});

test("translator handles SCHEMA without `required` array", () => {
  const anthropic = {
    name: "NoRequired",
    description: "All-optional tool.",
    input_schema: { type: "object", properties: { foo: { type: "string" } } },
  };
  const out = translateSchemaToOpenAI(anthropic);
  assert.equal(out.function.name, "NoRequired");
  assert.deepEqual(out.function.parameters, anthropic.input_schema);
});

// ---------- isolation: input is not mutated ----------

test("translator does not mutate the input SCHEMA object", () => {
  const anthropic = {
    name: "Pure",
    description: "x",
    input_schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
  };
  const before = JSON.stringify(anthropic);
  translateSchemaToOpenAI(anthropic);
  assert.equal(JSON.stringify(anthropic), before, "input must not be mutated");
});

test("output parameters is a deep copy (mutating output does not affect input)", () => {
  const anthropic = {
    name: "DeepCopy",
    description: "x",
    input_schema: { type: "object", properties: { a: { type: "string" } } },
  };
  const out = translateSchemaToOpenAI(anthropic);
  out.function.parameters.properties.a.type = "integer";
  assert.equal(anthropic.input_schema.properties.a.type, "string", "input properties must not change");
});

// ---------- batch: array translation ----------

test("translateSchemasToOpenAI maps an array of SCHEMAs", () => {
  const inputs = [
    { name: "A", description: "a", input_schema: { type: "object", properties: {} } },
    { name: "B", description: "b", input_schema: { type: "object", properties: {} } },
  ];
  const out = translateSchemasToOpenAI(inputs);
  assert.equal(out.length, 2);
  assert.equal(out[0].function.name, "A");
  assert.equal(out[1].function.name, "B");
  for (const o of out) assert.equal(o.type, "function");
});

test("translateSchemasToOpenAI on empty array returns empty array", () => {
  assert.deepEqual(translateSchemasToOpenAI([]), []);
});

// ---------- live registry round-trip ----------

test("every registered tool round-trips through the translator", () => {
  const all = getActiveTools({ allowWrite: true, allowWeb: true, allowBash: true });
  assert.ok(all.length >= 8, "should pick up the full tool set (Read/Glob/Grep/Write/Edit/WebFetch/WebSearch/Bash)");

  const out = translateSchemasToOpenAI(all.map((t) => t.SCHEMA));

  for (let i = 0; i < all.length; i++) {
    const src = all[i].SCHEMA;
    const dst = out[i];

    assert.equal(dst.type, "function", `${src.name}: type must be "function"`);
    assert.equal(dst.function.name, src.name, `${src.name}: name must round-trip`);
    assert.equal(
      dst.function.description,
      src.description,
      `${src.name}: description must round-trip`,
    );
    assert.deepEqual(
      dst.function.parameters,
      src.input_schema,
      `${src.name}: parameters must equal input_schema (OpenAI accepts JSON Schema verbatim)`,
    );
  }
});

test("registry round-trip preserves at least the canonical tool names", () => {
  const all = getActiveTools({ allowWrite: true, allowWeb: true, allowBash: true });
  const names = translateSchemasToOpenAI(all.map((t) => t.SCHEMA)).map((o) => o.function.name);
  // Sanity: the eight canonical Stage-1 tools must all appear.
  for (const expected of ["Read", "Glob", "Grep", "Write", "Edit", "WebFetch", "WebSearch", "Bash"]) {
    assert.ok(names.includes(expected), `${expected} must appear in translated output`);
  }
});

// ---------- error guardrails ----------

test("translator throws on missing name", () => {
  assert.throws(
    () => translateSchemaToOpenAI({ description: "x", input_schema: { type: "object" } }),
    /name/i,
  );
});

test("translator throws on missing input_schema", () => {
  assert.throws(
    () => translateSchemaToOpenAI({ name: "X", description: "x" }),
    /input_schema/i,
  );
});

test("translator throws on null/undefined input", () => {
  assert.throws(() => translateSchemaToOpenAI(null), /SCHEMA/);
  assert.throws(() => translateSchemaToOpenAI(undefined), /SCHEMA/);
});

// ---------- restore module resolver after suite ----------

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});

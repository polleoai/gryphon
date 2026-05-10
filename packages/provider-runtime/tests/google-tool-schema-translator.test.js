/**
 * Stage 3 (#18) Google/Gemini tool-schema translator tests.
 *
 * Pure-function TDD: validates Anthropic SCHEMA → Gemini's
 * `{ functionDeclarations: [...] }` shape per the design spec.
 *
 * Translation rules:
 *   - Wrap tool definitions as `{ functionDeclarations: [...] }` (one tools[]
 *     entry per Gemini call, NOT one per tool — that's the structural delta
 *     vs OpenAI's `tools: [{ type: "function", function: {...} }, ...]`).
 *   - Rename `input_schema` → `parameters`.
 *   - Strip `additionalProperties` from every level of the schema body
 *     (Gemini's JSON Schema dialect doesn't accept it; the API rejects
 *     the whole call with a 400 if present).
 *   - Validate enum shapes: only `string` enums are permitted by Gemini's
 *     dialect (no integer enums); the translator passes them through but
 *     surfaces a clear error if it encounters a non-string enum so the
 *     bug is caught at translator time rather than as a vague API 400.
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

const {
  translateSchemaToGemini,
  translateSchemasToGemini,
  stripAdditionalProperties,
} = require("../src/providers/google-api/tool-schema-translator");
const { getActiveTools } = require("../src/providers/anthropic-api/tools/tool-registry");

// ---------- single-schema translation ----------

test("translateSchemaToGemini renames input_schema → parameters and preserves name + description", () => {
  const anthropic = {
    name: "Read",
    description: "Read a file.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  };
  const out = translateSchemaToGemini(anthropic);
  assert.equal(out.name, "Read");
  assert.equal(out.description, "Read a file.");
  assert.deepEqual(out.parameters, {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  });
  assert.ok(!("input_schema" in out));
});

test("translator strips additionalProperties at every nesting depth (Gemini dialect)", () => {
  const anthropic = {
    name: "Tool",
    description: "x",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        opts: {
          type: "object",
          additionalProperties: true,
          properties: {
            sub: { type: "object", additionalProperties: false, properties: {} },
          },
        },
      },
    },
  };
  const out = translateSchemaToGemini(anthropic);
  function assertNoAdditional(obj) {
    if (!obj || typeof obj !== "object") return;
    assert.ok(!("additionalProperties" in obj), `additionalProperties found at ${JSON.stringify(obj).slice(0, 60)}`);
    for (const v of Object.values(obj)) assertNoAdditional(v);
  }
  assertNoAdditional(out.parameters);
});

test("translator does not mutate the input SCHEMA", () => {
  const anthropic = {
    name: "X",
    description: "x",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    },
  };
  const before = JSON.stringify(anthropic);
  translateSchemaToGemini(anthropic);
  assert.equal(JSON.stringify(anthropic), before);
});

test("translator preserves nested arrays + object structure (only additionalProperties is stripped)", () => {
  const anthropic = {
    name: "Complex",
    description: "complex",
    input_schema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" } },
        opts: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["read", "write"] },
            count: { type: "integer" },
          },
          required: ["mode"],
        },
      },
      required: ["files"],
    },
  };
  const out = translateSchemaToGemini(anthropic);
  // Deep-equal AGAINST the input minus additionalProperties (none present here).
  assert.deepEqual(out.parameters, anthropic.input_schema);
});

test("translator passes string enums through unchanged", () => {
  const anthropic = {
    name: "T",
    description: "t",
    input_schema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["a", "b", "c"] } },
    },
  };
  const out = translateSchemaToGemini(anthropic);
  assert.deepEqual(out.parameters.properties.mode.enum, ["a", "b", "c"]);
});

test("translator rejects non-string enums (Gemini dialect restriction)", () => {
  const anthropic = {
    name: "T",
    description: "t",
    input_schema: {
      type: "object",
      properties: { count: { type: "integer", enum: [1, 2, 3] } },
    },
  };
  assert.throws(
    () => translateSchemaToGemini(anthropic),
    /enum.*string|non-string enum/i,
  );
});

// ---------- batch translation: { functionDeclarations: [...] } envelope ----------

test("translateSchemasToGemini returns a single { functionDeclarations: [...] } object", () => {
  const inputs = [
    { name: "A", description: "a", input_schema: { type: "object", properties: {} } },
    { name: "B", description: "b", input_schema: { type: "object", properties: {} } },
  ];
  const out = translateSchemasToGemini(inputs);
  assert.equal(typeof out, "object");
  assert.ok(Array.isArray(out.functionDeclarations));
  assert.equal(out.functionDeclarations.length, 2);
  assert.equal(out.functionDeclarations[0].name, "A");
  assert.equal(out.functionDeclarations[1].name, "B");
});

test("translateSchemasToGemini on empty array returns { functionDeclarations: [] }", () => {
  const out = translateSchemasToGemini([]);
  assert.deepEqual(out, { functionDeclarations: [] });
});

test("translateSchemasToGemini throws on non-array input", () => {
  assert.throws(() => translateSchemasToGemini(null), /array/);
  assert.throws(() => translateSchemasToGemini({}), /array/);
});

// ---------- registry round-trip: every tool translates cleanly ----------

test("every registered tool round-trips through the Gemini translator", () => {
  const all = getActiveTools({ allowWrite: true, allowWeb: true, allowBash: true });
  assert.ok(all.length >= 8, "should pick up all canonical tools");
  const out = translateSchemasToGemini(all.map((t) => t.SCHEMA));
  assert.equal(out.functionDeclarations.length, all.length);
  for (let i = 0; i < all.length; i++) {
    const src = all[i].SCHEMA;
    const dst = out.functionDeclarations[i];
    assert.equal(dst.name, src.name);
    assert.equal(dst.description, src.description);
    // parameters is a deep clone of input_schema (without additionalProperties);
    // since none of our tool SCHEMAs use additionalProperties, the bodies match.
    assert.deepEqual(dst.parameters, src.input_schema);
  }
});

test("registry round-trip preserves the canonical tool names", () => {
  const all = getActiveTools({ allowWrite: true, allowWeb: true, allowBash: true });
  const names = translateSchemasToGemini(all.map((t) => t.SCHEMA))
    .functionDeclarations.map((d) => d.name);
  for (const expected of ["Read", "Glob", "Grep", "Write", "Edit", "WebFetch", "WebSearch", "Bash"]) {
    assert.ok(names.includes(expected), `${expected} must appear in translated output`);
  }
});

// ---------- helper exposed for unit testing ----------

test("stripAdditionalProperties returns a deep copy with the field removed at every depth", () => {
  const input = {
    a: 1,
    additionalProperties: false,
    nested: { additionalProperties: true, b: 2, deeper: { additionalProperties: false, c: 3 } },
    arr: [{ additionalProperties: false, d: 4 }],
  };
  const out = stripAdditionalProperties(input);
  assert.ok(!("additionalProperties" in out));
  assert.ok(!("additionalProperties" in out.nested));
  assert.ok(!("additionalProperties" in out.nested.deeper));
  assert.ok(!("additionalProperties" in out.arr[0]));
  // Non-stripped fields preserved
  assert.equal(out.a, 1);
  assert.equal(out.nested.b, 2);
  assert.equal(out.nested.deeper.c, 3);
  assert.equal(out.arr[0].d, 4);
  // Input unchanged
  assert.equal(input.additionalProperties, false);
});

// ---------- error guardrails ----------

test("translator throws on missing name", () => {
  assert.throws(
    () => translateSchemaToGemini({ description: "x", input_schema: { type: "object" } }),
    /name/i,
  );
});

test("translator throws on missing input_schema", () => {
  assert.throws(
    () => translateSchemaToGemini({ name: "X", description: "x" }),
    /input_schema/i,
  );
});

test("translator throws on null/undefined input", () => {
  assert.throws(() => translateSchemaToGemini(null), /SCHEMA/);
  assert.throws(() => translateSchemaToGemini(undefined), /SCHEMA/);
});

process.on("exit", () => {
  Module._resolveFilename = origResolve;
});

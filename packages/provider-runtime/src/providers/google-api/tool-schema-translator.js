/**
 * Anthropic SCHEMA → Gemini function-declaration format translator.
 *
 * Gryphon's tools register schemas in Anthropic shape:
 *   { name, description, input_schema: <JSON Schema> }
 *
 * Gemini's `generateContent({ ..., tools: [...] })` expects:
 *   tools: [{ functionDeclarations: [{ name, description, parameters }, ...] }]
 *
 * Note the structural delta vs OpenAI: Gemini groups all function
 * declarations into ONE `tools[]` entry (one `functionDeclarations` array)
 * — not one `tools[]` entry per function.
 *
 * Schema-dialect deltas vs OpenAI:
 *   - `additionalProperties` is rejected by Gemini at every depth — strip it.
 *   - Only `string` enums are permitted — surface non-string enums as a
 *     translator-time throw so the bug is caught locally rather than as
 *     a vague API 400.
 *
 * The translator deep-copies schema bodies so callers can mutate the
 * returned object without affecting the source registry.
 */

function translateSchemaToGemini(schema) {
  if (!schema || typeof schema !== "object") {
    throw new Error("translateSchemaToGemini: SCHEMA must be an object");
  }
  if (!schema.name) {
    throw new Error("translateSchemaToGemini: SCHEMA.name is required");
  }
  if (!schema.input_schema) {
    throw new Error("translateSchemaToGemini: SCHEMA.input_schema is required");
  }
  const parameters = stripAdditionalProperties(schema.input_schema);
  _validateGeminiSchemaDialect(parameters, schema.name);
  return {
    name: schema.name,
    description: schema.description || "",
    parameters,
  };
}

function translateSchemasToGemini(schemas) {
  if (!Array.isArray(schemas)) {
    throw new Error("translateSchemasToGemini: expected an array of SCHEMA objects");
  }
  return {
    functionDeclarations: schemas.map(translateSchemaToGemini),
  };
}

/**
 * Deep-copy a JSON-Schema-shaped object, removing `additionalProperties`
 * at every depth. Arrays + primitive values pass through unchanged
 * structurally; only object keys are filtered.
 */
function stripAdditionalProperties(value) {
  if (Array.isArray(value)) return value.map(stripAdditionalProperties);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "additionalProperties") continue;
      out[k] = stripAdditionalProperties(v);
    }
    return out;
  }
  return value;
}

/**
 * Walk the schema tree looking for known Gemini-dialect violations and
 * throw with a clear message. Currently checks: enum values must all be
 * strings (Gemini's JSON Schema dialect rejects integer/number enums on
 * function-call parameters).
 */
function _validateGeminiSchemaDialect(node, toolName, path = "") {
  if (Array.isArray(node)) {
    node.forEach((v, i) => _validateGeminiSchemaDialect(v, toolName, `${path}[${i}]`));
    return;
  }
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.enum)) {
    const badIndex = node.enum.findIndex((v) => typeof v !== "string");
    if (badIndex >= 0) {
      throw new Error(
        `translateSchemaToGemini(${toolName}): non-string enum value at ${path || "<root>"}` +
        ` — Gemini's JSON Schema dialect only accepts string enums. Got ${typeof node.enum[badIndex]}.`,
      );
    }
  }
  for (const [k, v] of Object.entries(node)) {
    _validateGeminiSchemaDialect(v, toolName, path ? `${path}.${k}` : k);
  }
}

module.exports = {
  translateSchemaToGemini,
  translateSchemasToGemini,
  stripAdditionalProperties,
};

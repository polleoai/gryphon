/**
 * Anthropic SCHEMA → OpenAI function-calling format translator.
 *
 * Gryphon's tools register schemas in Anthropic shape:
 *   { name, description, input_schema: <JSON Schema> }
 *
 * OpenAI's chat.completions tools[] expects:
 *   { type: "function", function: { name, description, parameters: <JSON Schema> } }
 *
 * The only structural change is the envelope + the input_schema → parameters
 * rename. OpenAI accepts standard JSON Schema verbatim (unlike Gemini, which
 * has a dialect; see google-api/tool-schema-translator.js when that lands).
 *
 * The translator deep-copies the schema body so callers can mutate the
 * returned object without affecting the source registry.
 */

function translateSchemaToOpenAI(schema) {
  if (!schema || typeof schema !== "object") {
    throw new Error("translateSchemaToOpenAI: SCHEMA must be an object");
  }
  if (!schema.name) {
    throw new Error("translateSchemaToOpenAI: SCHEMA.name is required");
  }
  if (!schema.input_schema) {
    throw new Error("translateSchemaToOpenAI: SCHEMA.input_schema is required");
  }
  return {
    type: "function",
    function: {
      name: schema.name,
      description: schema.description || "",
      parameters: deepClone(schema.input_schema),
    },
  };
}

function translateSchemasToOpenAI(schemas) {
  if (!Array.isArray(schemas)) {
    throw new Error("translateSchemasToOpenAI: expected an array of SCHEMA objects");
  }
  return schemas.map(translateSchemaToOpenAI);
}

function deepClone(value) {
  // Schemas are JSON-serializable by construction (JSON Schema), so the
  // structuredClone fallback to JSON round-trip is safe and dependency-free.
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

module.exports = { translateSchemaToOpenAI, translateSchemasToOpenAI };

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
export {};

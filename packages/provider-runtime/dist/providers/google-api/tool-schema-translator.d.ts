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
declare function translateSchemaToGemini(schema: any): {
    name: any;
    description: any;
    parameters: any;
};
declare function translateSchemasToGemini(schemas: any): {
    functionDeclarations: {
        name: any;
        description: any;
        parameters: any;
    }[];
};
/**
 * Deep-copy a JSON-Schema-shaped object, removing `additionalProperties`
 * at every depth. Arrays + primitive values pass through unchanged
 * structurally; only object keys are filtered.
 */
declare function stripAdditionalProperties(value: any): any;
export { translateSchemaToGemini, translateSchemasToGemini, stripAdditionalProperties, };

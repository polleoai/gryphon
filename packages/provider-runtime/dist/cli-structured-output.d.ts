/**
 * L6.1 — CLI structured-output helper.
 *
 * CLI providers (claude-code, codex-cli, gemini-cli) have no vendor
 * grammar constraint, so we approximate L6 by:
 *   1. injecting the JSON Schema into the system prompt
 *   2. parsing the response (stripping common ```json fences)
 *   3. validating against the schema
 *   4. retrying on failure up to a configurable budget
 *
 * Modern frontier models nail this >99% of the time but the failure
 * mode is real — exhausting the budget throws so the consumer can handle.
 *
 * The validator implements a deliberately minimal JSON Schema subset
 * covering: object/string/integer/number/boolean/array, properties,
 * required, additionalProperties:false, enum. This is what Peitho's
 * loop needs. Future consumers needing oneOf/$ref/etc. can swap in
 * ajv behind the same parseAndValidate signature without changing
 * call sites.
 */
declare class CliStructuredOutputError extends Error {
    [key: string]: any;
    constructor(message: string, { reason, attempts, lastOutput }?: {
        reason?: string;
        attempts?: number;
        lastOutput?: string;
    });
}
declare function injectSchemaHint(basePrompt: string, structuredOutput: {
    name: string;
    schema: object;
}): string;
declare function parseAndValidate(text: string, schema: any): unknown;
export { injectSchemaHint, parseAndValidate, CliStructuredOutputError, };

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

class CliStructuredOutputError extends Error {
  [key: string]: any;
  constructor(message: string, { reason, attempts, lastOutput }: { reason?: string; attempts?: number; lastOutput?: string } = {}) {
    super(message);
    this.name = "CliStructuredOutputError";
    this.reason = reason;            // "parse" | "validate" | "budget-exhausted"
    this.attempts = attempts;
    this.lastOutput = lastOutput;
  }
}

function injectSchemaHint(basePrompt: string, structuredOutput: { name: string; schema: object }): string {
  const schemaJson = JSON.stringify(
    { name: structuredOutput.name, schema: structuredOutput.schema },
    null,
    2,
  );
  return `${basePrompt}\n\n---\n\nYou must respond with a single JSON object matching this JSON Schema. Return ONLY the JSON, no prose, no markdown fence, no commentary:\n\n${schemaJson}`;
}

function stripFence(text: string): string {
  const m = text.match(/^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return m ? m[1] : text;
}

function parseAndValidate(text: string, schema: any): unknown {
  const cleaned = stripFence(text).trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new CliStructuredOutputError(
      `Model output is not valid JSON: ${(e as Error).message}`,
      { reason: "parse", lastOutput: cleaned },
    );
  }
  const errors = validate(parsed, schema, "");
  if (errors.length > 0) {
    throw new CliStructuredOutputError(
      `Model output failed schema validation: ${errors.join("; ")}`,
      { reason: "validate", lastOutput: cleaned },
    );
  }
  return parsed;
}

// Minimal JSON Schema validator. See module header for scope.
function validate(value: unknown, schema: any, path: string): string[] {
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path || "(root)"} must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return errors;   // an enum-mismatched value isn't worth deeper inspection
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path || "(root)"} expected object, got ${typeof value}`);
      return errors;
    }
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}/${key} required but missing`);
    }
    for (const [key, val] of Object.entries(value)) {
      if (key in props) {
        errors.push(...validate(val, props[key], `${path}/${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}/${key} not allowed (additionalProperties: false)`);
      }
    }
    return errors;
  }
  if (schema.type === "string" && typeof value !== "string") {
    errors.push(`${path} expected string, got ${typeof value}`);
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    errors.push(`${path} expected integer, got ${typeof value}`);
  }
  if (schema.type === "number" && typeof value !== "number") {
    errors.push(`${path} expected number, got ${typeof value}`);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path} expected boolean, got ${typeof value}`);
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} expected array, got ${typeof value}`);
    } else if (schema.items) {
      value.forEach((v, i) => errors.push(...validate(v, schema.items, `${path}/${i}`)));
    }
  }
  return errors;
}

module.exports = {
  injectSchemaHint,
  parseAndValidate,
  CliStructuredOutputError,
};

// packages/provider-runtime/tests/passive-arg-builder.test.ts
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPassiveArgs, DISALLOWED_BUILTINS } = require("../src/passive/arg-builder");

const base = { kind: "claude-code", cwd: "/tmp/work", model: "claude-sonnet-4-6", declaredTools: [] };

test("emits clean-room transport + flags", () => {
  const args = buildPassiveArgs(base);
  assert.ok(args.includes("--input-format") && args.includes("--output-format"));
  assert.ok(!args.includes("--print"), "persistent transport: no --print");
  assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-4-6");
  // C4/C5
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
});

test("uses --system-prompt REPLACE, never --append-system-prompt (C3)", () => {
  const args = buildPassiveArgs({ ...base, systemPrompt: "PROTOCOL" });
  assert.equal(args[args.indexOf("--system-prompt") + 1], "PROTOCOL");
  assert.ok(!args.includes("--append-system-prompt"));
});

test("empty system prompt is still a REPLACE (C3 clean slate)", () => {
  const args = buildPassiveArgs(base);
  assert.ok(args.includes("--system-prompt"));
  assert.equal(args[args.indexOf("--system-prompt") + 1], "");
});

test("disallows all 11 builtins (C6)", () => {
  const args = buildPassiveArgs(base);
  const v = args[args.indexOf("--disallowedTools") + 1];
  for (const t of DISALLOWED_BUILTINS) assert.ok(v.split(",").includes(t), `missing ${t}`);
});

test("omits --mcp-config when no mcpConfigPath given", () => {
  assert.ok(!buildPassiveArgs(base).includes("--mcp-config"));
});

test("includes --mcp-config when path given (Phase B)", () => {
  const args = buildPassiveArgs(base, { mcpConfigPath: "/tmp/mcp.json" });
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/mcp.json");
  assert.ok(args.includes("--strict-mcp-config"));
});

test("maxThinkingTokens flag only when set", () => {
  assert.ok(!buildPassiveArgs(base).includes("--max-thinking-tokens"));
  const args = buildPassiveArgs({ ...base, maxThinkingTokens: 2048 });
  assert.equal(args[args.indexOf("--max-thinking-tokens") + 1], "2048");
});

test("pre-authorizes declared tools via --allowedTools (spike refinement #2)", () => {
  // Without allowedTools, claude hits a permission gate and abandons the call.
  assert.ok(!buildPassiveArgs(base).includes("--allowedTools"));
  const args = buildPassiveArgs(base, { allowedTools: ["mcp__gryphon-passive__echo", "mcp__gryphon-passive__write_file"] });
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__gryphon-passive__echo,mcp__gryphon-passive__write_file");
});

test("empty allowedTools array emits no flag", () => {
  assert.ok(!buildPassiveArgs(base, { allowedTools: [] }).includes("--allowedTools"));
});

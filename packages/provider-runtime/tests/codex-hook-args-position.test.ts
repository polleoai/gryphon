// R43-2: hook-adapter args are Codex options and must precede the `--`
// that ends options; after it, Codex reads them as part of the prompt.
const test = require("node:test");
const assert = require("node:assert/strict");
const { _insertBeforePrompt } = require("../src/providers/codex-cli/codex-cli");

test("R43-2: hook args are inserted before `-- <prompt>`", () => {
  const args = ["exec", "--json", "--sandbox", "read-only", "--", "do the thing"];
  _insertBeforePrompt(args, ["-c", "features.hooks=true"]);
  assert.deepEqual(args, ["exec", "--json", "--sandbox", "read-only", "-c", "features.hooks=true", "--", "do the thing"]);
});

test("R43-2: without a `--`, hook args are appended", () => {
  const args = ["exec", "resume", "abc"];
  _insertBeforePrompt(args, ["-c", "features.hooks=true"]);
  assert.deepEqual(args, ["exec", "resume", "abc", "-c", "features.hooks=true"]);
});

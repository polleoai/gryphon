// R43-7 commit review: a store-guard FALLBACK must not switch Gemini to yolo.
const test = require("node:test");
const assert = require("node:assert/strict");
const { _hooksGateTools, GeminiCliProvider } = require("../src/providers/gemini-cli/gemini-cli");

test("R43-7: only full hooks (or the Protected-Mode-off store guard) count as gating tools", () => {
  assert.equal(_hooksGateTools({ ok: true, mode: "full" }), true);
  assert.equal(_hooksGateTools({ ok: true, mode: "store-guard-only" }), true);
  assert.equal(_hooksGateTools({ ok: true, mode: "store-guard-fallback" }), false);
  assert.equal(_hooksGateTools({ ok: false }), false);
});

test("R43-7: a fallback keeps the user's approval mode instead of yolo", { skip: typeof GeminiCliProvider !== "function" }, () => {
  const p = new GeminiCliProvider("/bin/gemini", "/tmp/vault", { permissionMode: "default" });
  const args = p._buildArgs("hi", { hooksWired: _hooksGateTools({ ok: true, mode: "store-guard-fallback" }) });
  const i = args.indexOf("--approval-mode");
  assert.notEqual(args[i + 1], "yolo");
});

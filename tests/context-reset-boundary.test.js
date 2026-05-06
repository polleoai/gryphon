/**
 * Issue #28 regression: /new (or /reset-context) inserts a boundary
 * marker that future seed-history extraction respects.
 *
 * Three guarantees verified:
 *
 *   1. Without a marker, _extractLlmTurnsFromFullHistory returns the
 *      tail of llm turns (existing v1.1.x behavior).
 *
 *   2. With a marker, only llm turns AFTER the marker are extracted.
 *      Visible bubbles before the marker stay in `_fullHistory` (the
 *      user can scroll back), but they don't seed the next provider.
 *
 *   3. Multiple markers — the LATEST one wins (most-recent reset
 *      defines the seed boundary, so a user who hits /new twice
 *      doesn't accidentally re-leak the older context).
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { GryphonChatView } = require("../src/chat-view");

function makeStub(fullHistory) {
  const stub = { _fullHistory: fullHistory };
  stub._extractLlmTurnsFromFullHistory =
    GryphonChatView.prototype._extractLlmTurnsFromFullHistory.bind(stub);
  return stub;
}

const llm = (role, text, ts) => ({ role, text, source: "llm", ts });
const reset = (ts) => ({
  role: "system",
  source: "context-reset",
  text: "── Context cleared ──",
  ts,
});

test("issue #28: no marker → seed includes full llm tail", () => {
  const stub = makeStub([
    llm("user", "u1", "1"),
    llm("assistant", "a1", "2"),
    llm("user", "u2", "3"),
    llm("assistant", "a2", "4"),
  ]);
  const seed = stub._extractLlmTurnsFromFullHistory();
  assert.deepEqual(seed, [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
  ]);
});

test("issue #28: marker truncates seed to turns AFTER it (privacy)", () => {
  const stub = makeStub([
    llm("user", "sensitive-1", "1"),
    llm("assistant", "secret-reply", "2"),
    reset("3"),
    llm("user", "fresh-prompt", "4"),
    llm("assistant", "fresh-reply", "5"),
  ]);
  const seed = stub._extractLlmTurnsFromFullHistory();
  assert.deepEqual(
    seed,
    [
      { role: "user", content: "fresh-prompt" },
      { role: "assistant", content: "fresh-reply" },
    ],
    "/new must hide pre-reset turns from the next provider seed",
  );
  // Visible bubbles must remain — _fullHistory itself isn't mutated.
  assert.equal(stub._fullHistory.length, 5,
    "_fullHistory keeps every entry; only the seed slice is filtered");
});

test("issue #28: latest marker wins when multiple resets occur", () => {
  const stub = makeStub([
    llm("user", "u1", "1"),
    reset("2"),
    llm("user", "u2", "3"),
    llm("assistant", "a2", "4"),
    reset("5"),
    llm("user", "fresh", "6"),
  ]);
  const seed = stub._extractLlmTurnsFromFullHistory();
  assert.deepEqual(seed, [{ role: "user", content: "fresh" }],
    "second reset must override the first — only post-second-reset turns seed");
});

test("issue #28: marker with NO subsequent llm turns yields empty seed", () => {
  const stub = makeStub([
    llm("user", "u1", "1"),
    llm("assistant", "a1", "2"),
    reset("3"),
  ]);
  const seed = stub._extractLlmTurnsFromFullHistory();
  assert.deepEqual(seed, [],
    "if /new is the last action, the next provider starts truly fresh");
});

test("issue #28: marker BEFORE any llm turn is a no-op vs full extraction", () => {
  // Defensive: a marker as the very first entry shouldn't break extraction.
  const stub = makeStub([
    reset("1"),
    llm("user", "u1", "2"),
    llm("assistant", "a1", "3"),
  ]);
  const seed = stub._extractLlmTurnsFromFullHistory();
  assert.deepEqual(seed, [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
  ]);
});

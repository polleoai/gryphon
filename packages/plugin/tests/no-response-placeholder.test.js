/**
 * Regression: Claude Code's `NO_RESPONSE_REQUESTED` synthetic message
 * (`'No response requested.'` — defined at cc/src/utils/messages.ts and
 * tagged in `SYNTHETIC_MESSAGES`) is replaced with a meaningful
 * explanation before the user sees it. Previously rendered verbatim,
 * which read as a non-sequitur — user reported this on a session of
 * repeated "continue" prompts whose CC turns ended without text and
 * surfaced the placeholder unchanged.
 *
 * Verified contracts:
 *   - Exact match (allowing surrounding whitespace) is replaced.
 *   - Near-misses ("No response required", "no response was requested")
 *     are LEFT ALONE — those could be legitimate model output.
 *   - The placeholder embedded inside a longer reply is LEFT ALONE —
 *     CC's synthetic-message contract is "the entire assistant text is
 *     this string"; preserving longer text avoids false positives where
 *     the model is quoting the phrase.
 *   - Idempotent on already-replaced text + clean text.
 *   - Non-string inputs are safe no-ops.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { _replaceNoResponsePlaceholder } = require("../src/chat-view");

test("placeholder: exact match is replaced", () => {
  const out = _replaceNoResponsePlaceholder("No response requested.");
  assert.notEqual(out, "No response requested.");
  assert.match(out, /tool-only turns|aborted streams|specific prompt/i,
    "replacement must explain what happened and offer a recovery path");
});

test("placeholder: leading + trailing whitespace tolerated", () => {
  const out = _replaceNoResponsePlaceholder("\n\n  No response requested.  \n");
  assert.notEqual(out.trim(), "No response requested.");
  assert.match(out, /model returned no text response/i);
});

test("placeholder: near-miss 'No response required' is NOT replaced", () => {
  const text = "No response required.";
  assert.equal(_replaceNoResponsePlaceholder(text), text,
    "only the exact CC synthetic constant is replaced; near-misses could be real model output");
});

test("placeholder: 'no response was requested' is NOT replaced", () => {
  const text = "no response was requested";
  assert.equal(_replaceNoResponsePlaceholder(text), text);
});

test("placeholder: phrase embedded in longer reply is LEFT ALONE", () => {
  // CC's contract: NO_RESPONSE_REQUESTED is the ENTIRE assistant text
  // when emitted, never embedded. If the model legitimately quotes the
  // phrase mid-reply, do not replace — that's their content.
  const text = "The phrase \"No response requested.\" is documented in CC's source.";
  assert.equal(_replaceNoResponsePlaceholder(text), text,
    "embedded references must not trigger replacement");
});

test("placeholder: clean text passes through unchanged", () => {
  const text = "Here's your summary: ...";
  assert.equal(_replaceNoResponsePlaceholder(text), text);
});

test("placeholder: empty string passes through", () => {
  assert.equal(_replaceNoResponsePlaceholder(""), "");
});

test("placeholder: non-string inputs are safe no-ops", () => {
  assert.equal(_replaceNoResponsePlaceholder(null), null);
  assert.equal(_replaceNoResponsePlaceholder(undefined), undefined);
  assert.equal(_replaceNoResponsePlaceholder(42), 42);
});

test("placeholder: idempotent on the replacement output", () => {
  // Running the replacer on already-replaced text shouldn't double-rewrite
  // — the replaced string doesn't equal NO_RESPONSE_REQUESTED.
  const once = _replaceNoResponsePlaceholder("No response requested.");
  const twice = _replaceNoResponsePlaceholder(once);
  assert.equal(once, twice);
});

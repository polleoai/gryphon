/**
 * _stripContextBlock — removes Gryphon-injected blocks from
 * persisted user-message text so the user's bubble (and the
 * up-arrow recall) shows only what they typed, not the augmented
 * payload the model sees.
 *
 * Regression target: with multiple reminder blocks (anti-drift +
 * compound + post-deny clarifier) all leading the augmented prompt,
 * a single-pass strip would only remove ONE of them and the rest
 * would leak into the user-visible recall. User report 2026-05-04
 * (Linux Claude Code: pressed up-arrow and saw the compound
 * reminder block instead of the original prompt).
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

// Minimal stub — strip is a pure prototype method, no DOM needed.
function makeStub() {
  const stub = {};
  stub._stripContextBlock = GryphonChatView.prototype._stripContextBlock.bind(stub);
  return stub;
}

const ctx = "[gryphon-context]\nactive_file: \"foo.md\"\n[/gryphon-context]";
const reminder1 = "[gryphon-reminder]\nanti-drift directive content here.\n[/gryphon-reminder]";
const reminder2 = "[gryphon-reminder]\ncompound-request directive content here.\n[/gryphon-reminder]";
const reminder3 = "[gryphon-reminder]\npost-deny clarifier content here.\n[/gryphon-reminder]";
const userText = "summarize the current file";

test("strip: single context block leaves user text", () => {
  const stub = makeStub();
  const out = stub._stripContextBlock(`${ctx}\n\n${userText}`);
  assert.strictEqual(out.trim(), userText);
});

test("strip: single reminder block leaves user text", () => {
  const stub = makeStub();
  const out = stub._stripContextBlock(`${reminder1}\n\n${userText}`);
  assert.strictEqual(out.trim(), userText);
});

test("strip: context + one reminder leaves user text", () => {
  const stub = makeStub();
  const out = stub._stripContextBlock(`${ctx}\n\n${reminder1}\n\n${userText}`);
  assert.strictEqual(out.trim(), userText);
});

test("strip: context + THREE reminder blocks leaves user text (the regression)", () => {
  const stub = makeStub();
  const out = stub._stripContextBlock(
    `${ctx}\n\n${reminder1}\n\n${reminder2}\n\n${reminder3}\n\n${userText}`,
  );
  assert.strictEqual(out.trim(), userText,
    "all three reminder blocks must strip — earlier behavior leaked the second + third into the user-visible bubble / up-arrow recall");
});

test("strip: blocks in mixed order are all removed", () => {
  // Reminder before context (unusual, but defensive).
  const stub = makeStub();
  const out = stub._stripContextBlock(`${reminder1}\n\n${ctx}\n\n${reminder2}\n\n${userText}`);
  assert.strictEqual(out.trim(), userText);
});

test("strip: bare user text passes through unchanged", () => {
  const stub = makeStub();
  const out = stub._stripContextBlock(userText);
  assert.strictEqual(out, userText);
});

test("strip: does NOT remove a reminder block that appears AFTER user text", () => {
  // The strip is intentionally only-leading. A user pasting block-shaped
  // text deeper in their message should keep it intact (defense against
  // false positives if the user is debugging Gryphon itself).
  const stub = makeStub();
  const input = `${userText}\n\n${reminder1}`;
  const out = stub._stripContextBlock(input);
  assert.strictEqual(out, input, "non-leading blocks must not be stripped");
});

test("strip: empty / non-string input is a safe no-op", () => {
  const stub = makeStub();
  assert.strictEqual(stub._stripContextBlock(""), "");
  assert.strictEqual(stub._stripContextBlock(null), null);
  assert.strictEqual(stub._stripContextBlock(undefined), undefined);
  assert.strictEqual(stub._stripContextBlock(42), 42);
});

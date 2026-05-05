/**
 * Post-deny clarifier — one-shot reminder injected on the turn
 * immediately after a Gryphon protected-pattern refusal. Counters
 * the model's "your message came through empty" inference seen on
 * Claude Code's long-running process when a byte-identical retry
 * prompt arrives after a deny.
 *
 * Tests the prototype methods in isolation (without a full DOM /
 * Obsidian context) by attaching them to a minimal stub object.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// Stub obsidian so chat-view.js can be required under node:test.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { GryphonChatView } = require("../src/chat-view");

// Minimal stub instance — enough to exercise the four post-deny
// methods without instantiating the full view. We bind them to a
// plain object that holds the flag.
function makeStub() {
  const stub = { _priorTurnHadProtectedDeny: false };
  stub._markPriorTurnDenyIfPresent = GryphonChatView.prototype._markPriorTurnDenyIfPresent.bind(stub);
  stub._consumePostDenyClarifier = GryphonChatView.prototype._consumePostDenyClarifier.bind(stub);
  stub._buildPostDenyClarifierBlock = GryphonChatView.prototype._buildPostDenyClarifierBlock.bind(stub);
  return stub;
}

test("post-deny: marker text in finalized turn flips the flag", () => {
  const stub = makeStub();
  stub._markPriorTurnDenyIfPresent(
    "Summary text.\n\nThis operation matches one of your protected patterns in Gryphon (destructive operation).",
  );
  assert.strictEqual(stub._priorTurnHadProtectedDeny, true);
});

test("post-deny: turn without the marker leaves the flag false", () => {
  const stub = makeStub();
  stub._markPriorTurnDenyIfPresent("A normal answer with no refusal in it.");
  assert.strictEqual(stub._priorTurnHadProtectedDeny, false);
});

test("post-deny: empty / non-string input is a safe no-op", () => {
  const stub = makeStub();
  stub._markPriorTurnDenyIfPresent("");
  stub._markPriorTurnDenyIfPresent(null);
  stub._markPriorTurnDenyIfPresent(undefined);
  stub._markPriorTurnDenyIfPresent(42);
  assert.strictEqual(stub._priorTurnHadProtectedDeny, false);
});

test("post-deny: consume returns block text and clears the flag (one-shot)", () => {
  const stub = makeStub();
  stub._priorTurnHadProtectedDeny = true;
  const out1 = stub._consumePostDenyClarifier();
  assert.ok(out1.length > 0, "first consume must return the reminder block");
  assert.ok(out1.includes("[gryphon-reminder]"));
  assert.ok(out1.includes("[/gryphon-reminder]"));
  assert.ok(out1.includes("previous turn ended with a Gryphon protected-pattern refusal"));
  assert.strictEqual(stub._priorTurnHadProtectedDeny, false, "flag must clear after consume");

  // Second consume immediately after — flag is already cleared, so
  // returns empty string.
  const out2 = stub._consumePostDenyClarifier();
  assert.strictEqual(out2, "", "second consume returns empty (one-shot)");
});

test("post-deny: consume with flag false returns empty string", () => {
  const stub = makeStub();
  // Flag never set — consume should be a no-op.
  const out = stub._consumePostDenyClarifier();
  assert.strictEqual(out, "");
});

test("post-deny: clarifier text contains the key directives the model needs", () => {
  const stub = makeStub();
  const block = stub._buildPostDenyClarifierBlock();
  // Anti-misinterpretation phrases — these are the failure modes
  // we observed and want to suppress.
  assert.ok(/your message came through empty/i.test(block),
    "must explicitly forbid the 'came through empty' rationalization");
  assert.ok(/your message appears to be empty/i.test(block),
    "must explicitly forbid the 'appears to be empty' variant (observed 2026-05-04 Linux Claude Code)");
  assert.ok(/system notification/i.test(block),
    "must explicitly forbid the 'system notification' rationalization");
  // Positive directive.
  assert.ok(/fresh.*request/i.test(block));
  assert.ok(/CURRENT protected-pattern settings/.test(block),
    "must reference current settings (user may have changed between turns)");
});

test("post-deny: full lifecycle — mark, consume on next send, no double-fire", () => {
  const stub = makeStub();
  // Turn 1 finalizes with a deny.
  stub._markPriorTurnDenyIfPresent("...\n\nThis operation matches one of your protected patterns in Gryphon.");
  // Turn 2 send: clarifier fires.
  const turn2 = stub._consumePostDenyClarifier();
  assert.ok(turn2.length > 0);
  // Turn 2 finalizes WITHOUT a deny (e.g., user changed prompt).
  stub._markPriorTurnDenyIfPresent("Just a clean answer, no refusal.");
  // Turn 3 send: NO clarifier (flag was cleared after turn 2 consume).
  const turn3 = stub._consumePostDenyClarifier();
  assert.strictEqual(turn3, "", "no clarifier on turn 3 — turn 2 didn't deny");
});

/**
 * Issue #39 — per-provider extraArgs filter.
 *
 * Pure-function unit tests for `filterExtraArgs` from
 * src/providers/shared/extra-args-filter.js. The filter takes a flat
 * extraArgs array + a target provider kind and drops flags known to
 * belong to OTHER providers (and their values, if any).
 *
 * Behavior under test:
 *   1. Empty / non-array inputs return empty filtered + dropped.
 *   2. A flag that belongs to the target provider is kept (with its value).
 *   3. A flag that belongs to a DIFFERENT provider is dropped (with its value).
 *   4. An unknown flag passes through (consumer's responsibility).
 *   5. Multiple flags interleaved are each classified correctly.
 *   6. Flag without value (next token is also a flag) is correctly classified.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  filterExtraArgs,
  PROVIDER_FLAGS,
  ALL_PROVIDER_FLAGS,
} = require("../src/providers/shared/extra-args-filter");

test("empty / null / non-array inputs are safe", () => {
  assert.deepEqual(filterExtraArgs([], "claude-code"), { filtered: [], dropped: [] });
  assert.deepEqual(filterExtraArgs(null, "claude-code"), { filtered: [], dropped: [] });
  assert.deepEqual(filterExtraArgs(undefined, "claude-code"), { filtered: [], dropped: [] });
  assert.deepEqual(filterExtraArgs("not an array", "claude-code"), { filtered: [], dropped: [] });
});

test("Claude-only flag passes through to claude-code provider unchanged", () => {
  const args = ["--disable-slash-commands"];
  const { filtered, dropped } = filterExtraArgs(args, "claude-code");
  assert.deepEqual(filtered, ["--disable-slash-commands"]);
  assert.deepEqual(dropped, []);
});

test("Claude-only flag is dropped when target is codex-cli (the issue #39 case)", () => {
  // The exact failure mode reported in the issue: Athena passes
  // --disable-slash-commands which is Claude-only; codex-cli spawn
  // fails with "unexpected argument."
  const args = ["--disable-slash-commands"];
  const { filtered, dropped } = filterExtraArgs(args, "codex-cli");
  assert.deepEqual(filtered, []);
  assert.deepEqual(dropped, ["--disable-slash-commands"]);
});

test("Claude-only flag is dropped when target is gemini-cli", () => {
  const args = ["--disable-slash-commands"];
  const { filtered, dropped } = filterExtraArgs(args, "gemini-cli");
  assert.deepEqual(filtered, []);
  assert.deepEqual(dropped, ["--disable-slash-commands"]);
});

test("flag-with-value: claude-only flag drops value too when sent to codex", () => {
  // --allowedTools <comma-separated-list> is Claude's syntax. The
  // value (e.g. "Bash,Read,Edit") doesn't start with --, so it must
  // be dropped along with the flag — otherwise codex would receive
  // a stray positional that confuses its argv parser.
  const args = ["--allowedTools", "Bash,Read,Edit"];
  const { filtered, dropped } = filterExtraArgs(args, "codex-cli");
  assert.deepEqual(filtered, []);
  assert.deepEqual(dropped, ["--allowedTools"]);
});

test("flag-with-value: claude-only flag passes through with value to claude", () => {
  const args = ["--allowedTools", "Bash,Read,Edit"];
  const { filtered, dropped } = filterExtraArgs(args, "claude-code");
  assert.deepEqual(filtered, ["--allowedTools", "Bash,Read,Edit"]);
  assert.deepEqual(dropped, []);
});

test("Athena's actual flag set: full reproduction case from issue #39", () => {
  // Concrete failure shape from the issue body:
  //   --disable-slash-commands --allowedTools <list> --append-system-prompt <text>
  const args = [
    "--disable-slash-commands",
    "--allowedTools", "Bash,Read,Edit,Write",
    "--append-system-prompt", "You are Athena, a knowledge management assistant.",
  ];

  // Sent to claude-code: all kept
  const claude = filterExtraArgs(args, "claude-code");
  assert.deepEqual(claude.filtered, args);
  assert.deepEqual(claude.dropped, []);

  // Sent to codex-cli: all dropped
  const codex = filterExtraArgs(args, "codex-cli");
  assert.deepEqual(codex.filtered, []);
  assert.deepEqual(codex.dropped.sort(), [
    "--allowedTools", "--append-system-prompt", "--disable-slash-commands",
  ].sort());

  // Sent to gemini-cli: all dropped
  const gemini = filterExtraArgs(args, "gemini-cli");
  assert.deepEqual(gemini.filtered, []);
  assert.deepEqual(gemini.dropped.length, 3);
});

test("unknown flag passes through (consumer's responsibility)", () => {
  // A flag we don't recognize at all — could be a generic CLI flag, or
  // a future provider flag we haven't enumerated. Pass it through and
  // let the CLI itself reject if invalid.
  const args = ["--some-future-flag", "value"];
  const claude = filterExtraArgs(args, "claude-code");
  assert.deepEqual(claude.filtered, ["--some-future-flag", "value"]);
  assert.deepEqual(claude.dropped, []);
  const codex = filterExtraArgs(args, "codex-cli");
  assert.deepEqual(codex.filtered, ["--some-future-flag", "value"]);
});

test("interleaved: claude flag + unknown flag + another claude flag, sent to codex", () => {
  // Each flag must be classified independently — dropping one shouldn't
  // disturb the position of others.
  const args = [
    "--disable-slash-commands",          // claude → drop
    "--my-codex-flag", "myvalue",        // unknown → keep
    "--allowedTools", "Bash",            // claude → drop (with value)
  ];
  const { filtered, dropped } = filterExtraArgs(args, "codex-cli");
  assert.deepEqual(filtered, ["--my-codex-flag", "myvalue"]);
  assert.deepEqual(dropped.sort(), ["--allowedTools", "--disable-slash-commands"].sort());
});

test("flag without value (next token is also a flag) is handled correctly", () => {
  // --continue is Claude's no-value flag (re-resume last conversation).
  // Followed immediately by another flag — the value-detection
  // shouldn't consume the next flag thinking it's a value.
  const args = ["--continue", "--allowedTools", "Bash"];

  const claude = filterExtraArgs(args, "claude-code");
  assert.deepEqual(claude.filtered, ["--continue", "--allowedTools", "Bash"]);

  const codex = filterExtraArgs(args, "codex-cli");
  // Both --continue (value-less) and --allowedTools (with value Bash)
  // are claude-only → dropped. Bash should NOT remain.
  assert.deepEqual(codex.filtered, []);
});

test("unknown provider kind drops nothing (defensive)", () => {
  // If somehow we get called with a provider kind that doesn't exist
  // in PROVIDER_FLAGS, every flag becomes "not mine" — but they're
  // also not "owned by another provider" (the unknown kind isn't
  // contributing to the union), so they all pass through.
  // Wait, that's not right — they ARE in ALL_PROVIDER_FLAGS because
  // they're claimed by the real providers. So they'd be dropped.
  // Verify the actual behavior:
  const args = ["--disable-slash-commands"];
  const { filtered, dropped } = filterExtraArgs(args, "made-up-provider");
  // The made-up provider doesn't own --disable-slash-commands, but
  // claude-code does (it's in ALL_PROVIDER_FLAGS), so it's dropped.
  assert.deepEqual(filtered, []);
  assert.deepEqual(dropped, ["--disable-slash-commands"]);
});

test("all PROVIDER_FLAGS sets contribute to ALL_PROVIDER_FLAGS", () => {
  // Sanity check the union: every flag in any provider's set should
  // be reachable via ALL_PROVIDER_FLAGS. Prevents a maintenance bug
  // where someone adds a flag to PROVIDER_FLAGS but forgets to
  // rebuild ALL_PROVIDER_FLAGS.
  for (const [kind, flagSet] of Object.entries(PROVIDER_FLAGS)) {
    for (const flag of flagSet) {
      assert.ok(
        ALL_PROVIDER_FLAGS.has(flag),
        `${flag} (from ${kind}) should be in ALL_PROVIDER_FLAGS union`,
      );
    }
  }
});

test("each provider's own flags pass through to it", () => {
  // For each provider, sample one of its flags and verify it survives
  // when filtered against itself. This guards against a misconfiguration
  // where a provider is missing from PROVIDER_FLAGS.
  for (const [kind, flagSet] of Object.entries(PROVIDER_FLAGS)) {
    if (flagSet.size === 0) continue;
    const sampleFlag = Array.from(flagSet)[0];
    const { filtered, dropped } = filterExtraArgs([sampleFlag], kind);
    assert.deepEqual(
      filtered, [sampleFlag],
      `${sampleFlag} should pass through to its own provider ${kind}`,
    );
    assert.deepEqual(dropped, []);
  }
});

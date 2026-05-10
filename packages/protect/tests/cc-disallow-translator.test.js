/**
 * Tests for the CC `--disallowedTools` translator (v0.5.6 — CLI
 * integration). Verifies Gryphon protected-pattern entries map into the
 * glob rules CC actually accepts.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDisallowedTools,
  _globsForPath,
  _globsForCommand,
  _extractKeyword,
  CC_GLOBS_FOR_COMMAND_PATTERN,
} = require("../src/cc-disallow-translator");
const {
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_PROTECTED_COMMANDS,
} = require("../src/constants");

// ── Path translation ───────────────────────────────────────────────────

test("directory-prefix path produces Write + Edit globs under the prefix", () => {
  const globs = _globsForPath(".obsidian/plugins/gryphon/");
  assert.ok(globs.includes("Write(.obsidian/plugins/gryphon/**)"));
  assert.ok(globs.includes("Edit(.obsidian/plugins/gryphon/**)"));
  // Also covers the bare directory path itself (someone could ask to
  // create the directory as a file, or a `Write(<dir-path>)` shape
  // the tool might accept).
  assert.ok(globs.includes("Write(.obsidian/plugins/gryphon)"));
  assert.ok(globs.includes("Edit(.obsidian/plugins/gryphon)"));
});

test("exact file path produces Write + Edit globs with no wildcard", () => {
  const globs = _globsForPath(".obsidian/community-plugins.json");
  assert.deepEqual(globs, [
    "Write(.obsidian/community-plugins.json)",
    "Edit(.obsidian/community-plugins.json)",
  ]);
});

test("object-form entry is supported (for pattern objects with metadata)", () => {
  const globs = _globsForPath({
    pattern: ".git/hooks/",
    category: "persistent-execution",
    userRisk: "…",
  });
  assert.ok(globs.includes("Write(.git/hooks/**)"));
  assert.ok(globs.includes("Edit(.git/hooks/**)"));
});

test("invalid/empty path returns empty", () => {
  assert.deepEqual(_globsForPath(""), []);
  assert.deepEqual(_globsForPath(null), []);
  assert.deepEqual(_globsForPath({}), []);
});

// ── Command translation ────────────────────────────────────────────────

test("known default command pattern maps to its predefined glob set", () => {
  // The `rm` recursive pattern gained optional surrounding quotes in
  // the v0.9 hardening arc to catch `'rm' -rf` bypasses. Test uses
  // the current pattern string as the map key.
  const rmPattern = "\\b['\"]?rm['\"]?\\s+-[a-z]*r[a-z]*\\b";
  const globs = _globsForCommand(rmPattern);
  assert.ok(globs.length > 0);
  // Spot-check a few expected entries
  assert.ok(globs.includes("Bash(rm -r*)"));
  assert.ok(globs.includes("Bash(*rm -r*)"));
});

test("sudo pattern maps to globs covering sudo/su/doas/pkexec", () => {
  const globs = _globsForCommand("\\b(sudo|su|doas|pkexec)\\b");
  assert.ok(globs.some((g) => g.includes("sudo")));
  assert.ok(globs.some((g) => g.includes("su ")));
  assert.ok(globs.some((g) => g.includes("doas")));
  assert.ok(globs.some((g) => g.includes("pkexec")));
});

test("custom (unmapped) regex falls back to keyword extraction", () => {
  // A made-up user regex that isn't in our map — we extract the
  // literal keyword "myCustom" and wrap it with Bash(*<keyword>*).
  const globs = _globsForCommand("\\bmyCustomBinary\\b");
  assert.deepEqual(globs, ["Bash(*myCustomBinary*)"]);
});

test("regex with no usable keyword returns empty (documented limitation)", () => {
  // All metachars, no literal identifier — nothing to match against.
  const globs = _globsForCommand("\\s+|\\d+");
  assert.deepEqual(globs, []);
});

test("invalid/empty command returns empty", () => {
  assert.deepEqual(_globsForCommand(""), []);
  assert.deepEqual(_globsForCommand(null), []);
  assert.deepEqual(_globsForCommand({}), []);
});

// ── _extractKeyword ────────────────────────────────────────────────────

test("extracts first literal keyword from a regex", () => {
  assert.equal(_extractKeyword("\\brm\\s+-rf\\b"), "rm");
  assert.equal(_extractKeyword("\\bsudo\\b"), "sudo");
  assert.equal(_extractKeyword("(curl|wget).*\\| bash"), "curl");
});

test("returns empty string when no literal characters remain", () => {
  assert.equal(_extractKeyword("\\s+|\\d+"), "");
  assert.equal(_extractKeyword("^$"), "");
  assert.equal(_extractKeyword(""), "");
});

// ── End-to-end: buildDisallowedTools ───────────────────────────────────

test("null / undefined settings produce empty deny list (defensive)", () => {
  assert.deepEqual(buildDisallowedTools(null), []);
  assert.deepEqual(buildDisallowedTools(undefined), []);
});

test("empty settings object still applies all default protections", () => {
  // An empty settings object means the user hasn't disabled any
  // default — so every default protected pattern translates into
  // CC glob rules. This is the expected shape on first load.
  const result = buildDisallowedTools({});
  assert.ok(result.length > 0, "expected defaults to produce rules");
  assert.ok(result.some((g) => g.includes(".obsidian/plugins/gryphon/**")));
});

test("defaults-on settings produce non-empty deny list covering Gryphon config", () => {
  const result = buildDisallowedTools({
    protectedPathsDisabled: [],
    protectedPathsCustom: [],
    protectedCommandsDisabled: [],
    protectedCommandsCustom: [],
  });
  assert.ok(result.length > 0);
  // Must include the Gryphon-own-config protection (highest priority)
  assert.ok(result.some((g) => g === "Write(.obsidian/plugins/gryphon/**)"));
  assert.ok(result.some((g) => g === "Edit(.obsidian/plugins/gryphon/**)"));
  // Must include rm -r protection
  assert.ok(result.some((g) => /rm -r/.test(g)));
});

test("disabling a default removes it from the deny list", () => {
  const withGryphonConfig = buildDisallowedTools({ protectedPathsDisabled: [] });
  const withoutGryphonConfig = buildDisallowedTools({
    protectedPathsDisabled: [".obsidian/plugins/gryphon/"],
  });
  // With-it has the Gryphon-config deny rules; without-it doesn't.
  assert.ok(withGryphonConfig.some((g) => g.includes(".obsidian/plugins/gryphon/**")));
  assert.ok(!withoutGryphonConfig.some((g) => g.includes(".obsidian/plugins/gryphon/**")));
});

test("custom path entry shows up in the deny list", () => {
  const result = buildDisallowedTools({
    protectedPathsCustom: ["notes/secrets/"],
  });
  assert.ok(result.some((g) => g === "Write(notes/secrets/**)"));
  assert.ok(result.some((g) => g === "Edit(notes/secrets/**)"));
});

test("custom command regex with a keyword lands in deny list", () => {
  const result = buildDisallowedTools({
    protectedCommandsCustom: ["\\bmyBinary\\b"],
  });
  assert.ok(result.some((g) => g === "Bash(*myBinary*)"));
});

test("result is deduplicated", () => {
  const result = buildDisallowedTools({
    protectedPathsCustom: [".obsidian/plugins/gryphon/"],  // duplicate of a default
  });
  const counts = {};
  for (const g of result) counts[g] = (counts[g] || 0) + 1;
  for (const [g, n] of Object.entries(counts)) {
    assert.equal(n, 1, `duplicate glob in output: ${g} (x${n})`);
  }
});

// ── Every default command pattern has a mapping ───────────────────────

test("every DEFAULT_PROTECTED_COMMANDS pattern is in the CC glob map", () => {
  for (const entry of DEFAULT_PROTECTED_COMMANDS) {
    const pattern = typeof entry === "string" ? entry : entry.pattern;
    assert.ok(
      CC_GLOBS_FOR_COMMAND_PATTERN.has(pattern),
      `missing CC glob translation for default command pattern: ${pattern}`,
    );
  }
});

test("every DEFAULT_PROTECTED_PATHS entry translates to at least Write + Edit globs", () => {
  for (const entry of DEFAULT_PROTECTED_PATHS) {
    const globs = _globsForPath(entry);
    assert.ok(globs.length >= 2, `path entry produced too few globs: ${JSON.stringify(entry)}`);
    assert.ok(globs.some((g) => g.startsWith("Write(")));
    assert.ok(globs.some((g) => g.startsWith("Edit(")));
  }
});

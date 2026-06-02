/**
 * deny-copy.js — single source of truth for the canonical Gryphon
 * protected-deny copy. These tests pin the exact output shape so
 * future edits don't accidentally drift the wording, which would
 * cause models to paraphrase divergently across providers.
 *
 * The canonical text (2026-05-04) is descriptive: it names the
 * operation, target, and matched category in plain language. See
 * src/providers/shared/deny-copy.js for the full rationale.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
  CANONICAL_OPENING,
  describeOperation,
  settingsPathForKind,
  buildDenyReason,
} = require("../src/deny-copy");

test("opening: canonical opening is the byte-stable phrase used as a marker", () => {
  // chat-view's _CANONICAL_BLOCK_MARKERS depends on this exact
  // string to identify deny blocks for paragraph separation. If
  // this drifts, dedupe / draft-fold / post-deny clarifier all
  // miss the deny block and stop working.
  assert.strictEqual(CANONICAL_OPENING, "The Gryphon plugin is blocking the ");
});

test("describeOperation: write tool produces 'write to <path>'", () => {
  assert.strictEqual(
    describeOperation("write", ".obsidian/plugins/gryphon/data.json"),
    "write to `.obsidian/plugins/gryphon/data.json`",
  );
});

test("describeOperation: edit tool produces 'edit of <path>'", () => {
  assert.strictEqual(describeOperation("edit", "foo.md"), "edit of `foo.md`");
});

test("describeOperation: shell rm command extracts the deletion target", () => {
  // Special-case: when the shell command starts with rm/del/erase/
  // unlink/shred/rmdir, surface the path being deleted so the deny
  // copy reads "deletion of `<path>`" instead of "execution of
  // `<full command>`". This matches the descriptive wording the
  // user requested 2026-05-04.
  assert.strictEqual(describeOperation("run", "rm /tmp/chongxu.md"), "deletion of `/tmp/chongxu.md`");
  assert.strictEqual(describeOperation("run", "rm -rf /tmp/foo"), "deletion of `/tmp/foo`");
  assert.strictEqual(describeOperation("run", "sudo rm -rf /etc/something"), "deletion of `/etc/something`");
  assert.strictEqual(describeOperation("run", "del C:\\temp\\file"), "deletion of `C:\\temp\\file`");
});

test("describeOperation: non-destructive shell command falls back to 'execution of'", () => {
  assert.strictEqual(describeOperation("run", "ls -la"), "execution of `ls -la`");
  assert.strictEqual(describeOperation("run", "curl https://example.com"), "execution of `curl https://example.com`");
});

test("describeOperation: empty / non-string target is handled gracefully", () => {
  assert.strictEqual(describeOperation("run", ""), "execution of ``");
  assert.strictEqual(describeOperation("write", null), "write to ``");
});

test("settingsPathForKind: protected-exec → 'Protected commands'", () => {
  assert.strictEqual(settingsPathForKind("protected-exec"), "Protected commands");
});

test("settingsPathForKind: protected → 'Protected file paths'", () => {
  assert.strictEqual(settingsPathForKind("protected"), "Protected file paths");
});

test("settingsPathForKind: anything else (defensive) → 'Protected file paths'", () => {
  assert.strictEqual(settingsPathForKind(undefined), "Protected file paths");
  assert.strictEqual(settingsPathForKind("fileEdit"), "Protected file paths");
});

test("buildDenyReason: full descriptive form for rm with category", () => {
  const out = buildDenyReason({
    action: "run",
    target: "rm /tmp/chongxu.md",
    category: "destructive-operation",
    kind: "protected-exec",
  });
  // Must lead with the canonical opening + operation description.
  assert.ok(out.startsWith("The Gryphon plugin is blocking the deletion of `/tmp/chongxu.md`"),
    "lead with descriptive operation");
  // Must include the parenthetical category (with hyphens replaced).
  assert.ok(out.includes("(destructive operation)"),
    "category appears parenthetical with hyphens spaced");
  // Must include the bullet-list action steps for the right settings page.
  assert.ok(out.includes("Open Obsidian → Settings → Gryphon → Protected commands"));
  assert.ok(out.includes("Uncheck the matching pattern"));
  assert.ok(out.includes("Ask me again"));
});

test("buildDenyReason: file edit form names the file path", () => {
  const out = buildDenyReason({
    action: "write",
    target: ".obsidian/plugins/gryphon/data.json",
    category: "modifies-gryphon",
    kind: "protected",
  });
  assert.ok(out.includes("write to `.obsidian/plugins/gryphon/data.json`"));
  assert.ok(out.includes("(modifies gryphon)"));
  assert.ok(out.includes("Protected file paths"));
});

test("buildDenyReason: null category produces no parenthetical", () => {
  const out = buildDenyReason({
    action: "run",
    target: "rm foo",
    category: null,
    kind: "protected-exec",
  });
  // When the category is unknown (e.g. auto-deny path without
  // structured classification), we still produce useful copy
  // without a stray empty parenthetical.
  assert.ok(out.startsWith("The Gryphon plugin is blocking the deletion of `foo`"));
  assert.ok(!out.includes("()"), "no empty parenthetical for null category");
  assert.ok(!out.includes("( )"), "no whitespace-only parenthetical");
});

test("buildDenyReason: round-trip through chat-view's canonical-marker recognition", () => {
  // Smoke check that the produced text starts with the marker
  // string chat-view's _CANONICAL_BLOCK_MARKERS uses for paragraph
  // separation / dedupe / post-deny clarifier flag.
  const out = buildDenyReason({
    action: "run",
    target: "rm /tmp/x",
    category: "destructive-operation",
    kind: "protected-exec",
  });
  assert.ok(out.startsWith(CANONICAL_OPENING));
});

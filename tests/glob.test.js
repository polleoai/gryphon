/**
 * Tests for the Glob tool's pattern translator.
 *
 * The internals (_globToRegex, _expandBraces) are exported from glob.js
 * specifically so we can unit-test them without setting up a temp vault
 * for every assertion. The execute() function gets one integration test
 * to confirm the full path (vault walk + sort + format) works end-to-end.
 *
 * Run with: npm test
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Glob = require("../src/providers/anthropic-api/tools/glob");

// ── Brace expansion ─────────────────────────────────────────────────────

test("brace expansion: single brace produces N variants", () => {
  assert.deepEqual(
    Glob._expandBraces("file.{js,ts,jsx}"),
    ["file.js", "file.ts", "file.jsx"]
  );
});

test("brace expansion: pattern without braces is unchanged", () => {
  assert.deepEqual(Glob._expandBraces("**/*.md"), ["**/*.md"]);
});

test("brace expansion: nested braces expand recursively", () => {
  // First brace expanded → "src/{js,ts}/file.md" + "test/{js,ts}/file.md"
  // Then second brace expanded in each
  const result = Glob._expandBraces("{src,test}/{js,ts}/file.md");
  assert.equal(result.length, 4);
  assert.ok(result.includes("src/js/file.md"));
  assert.ok(result.includes("src/ts/file.md"));
  assert.ok(result.includes("test/js/file.md"));
  assert.ok(result.includes("test/ts/file.md"));
});

test("brace expansion: single-element brace works (degenerate)", () => {
  assert.deepEqual(Glob._expandBraces("file.{md}"), ["file.md"]);
});

// ── Glob → regex translation ────────────────────────────────────────────

test("simple star matches single path segment", () => {
  const re = Glob._globToRegex("*.md");
  assert.ok(re.test("note.md"));
  assert.ok(re.test("a.md"));
  assert.ok(!re.test("dir/note.md"));    // * doesn't cross /
  assert.ok(!re.test("note.txt"));        // wrong ext
});

test("double star matches across path separators", () => {
  const re = Glob._globToRegex("**/*.md");
  assert.ok(re.test("note.md"));
  assert.ok(re.test("dir/note.md"));
  assert.ok(re.test("a/b/c/note.md"));
  assert.ok(!re.test("note.txt"));
});

test("recursive directory glob with extension", () => {
  const re = Glob._globToRegex("src/**/*.js");
  assert.ok(re.test("src/index.js"));
  assert.ok(re.test("src/components/Button.js"));
  assert.ok(re.test("src/a/b/c/d.js"));
  assert.ok(!re.test("test/index.js"));    // wrong root
  assert.ok(!re.test("src/index.ts"));     // wrong ext
});

test("question mark matches single non-slash character", () => {
  const re = Glob._globToRegex("?ote.md");
  assert.ok(re.test("note.md"));
  assert.ok(re.test("vote.md"));
  assert.ok(!re.test("note.txt"));
  assert.ok(!re.test("a/note.md"));        // ? doesn't cross /
  assert.ok(!re.test("noote.md"));         // exactly one char
});

test("character class matches one of the listed chars", () => {
  const re = Glob._globToRegex("[abc].md");
  assert.ok(re.test("a.md"));
  assert.ok(re.test("b.md"));
  assert.ok(re.test("c.md"));
  assert.ok(!re.test("d.md"));
});

test("dot in pattern is matched literally, not as regex any-char", () => {
  const re = Glob._globToRegex("a.md");
  assert.ok(re.test("a.md"));
  assert.ok(!re.test("aXmd"));             // dot is literal
  assert.ok(!re.test("ab.md"));            // length mismatch
});

test("plus and parens are escaped (don't act as regex metachars)", () => {
  const re = Glob._globToRegex("a+b(c).md");
  assert.ok(re.test("a+b(c).md"));         // literal match
  assert.ok(!re.test("aab(c).md"));        // + is not a quantifier here
});

test("brace expansion with star inside one variant", () => {
  const re = Glob._globToRegex("*.{js,ts}");
  assert.ok(re.test("foo.js"));
  assert.ok(re.test("foo.ts"));
  assert.ok(!re.test("foo.tsx"));
});

test("** alone matches any path (including root)", () => {
  const re = Glob._globToRegex("**");
  assert.ok(re.test(""));
  assert.ok(re.test("a"));
  assert.ok(re.test("a/b"));
  assert.ok(re.test("a/b/c.md"));
});

// ── Integration: full execute() path ────────────────────────────────────

function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-glob-test-"));
  return fs.realpathSync(dir);
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

test("execute(): finds matching files in vault, ignores .git", async () => {
  const vault = makeVault();
  try {
    fs.mkdirSync(path.join(vault, "wiki"));
    fs.mkdirSync(path.join(vault, ".git"));
    fs.writeFileSync(path.join(vault, "note.md"), "");
    fs.writeFileSync(path.join(vault, "wiki", "topic.md"), "");
    fs.writeFileSync(path.join(vault, ".git", "HEAD"), "");
    fs.writeFileSync(path.join(vault, "ignore.txt"), "");

    const result = await Glob.execute(
      { pattern: "**/*.md" },
      { vaultRoot: vault }
    );

    assert.equal(result.isError, false);
    const text = result.content[0].text;
    assert.ok(text.includes("note.md"));
    assert.ok(text.includes("topic.md"));
    assert.ok(!text.includes("ignore.txt"));
    assert.ok(!text.includes("HEAD"));         // .git is excluded
  } finally { cleanup(vault); }
});

test("execute(): returns 'no files matched' when pattern matches nothing", async () => {
  const vault = makeVault();
  try {
    fs.writeFileSync(path.join(vault, "note.md"), "");

    const result = await Glob.execute(
      { pattern: "**/*.does-not-exist" },
      { vaultRoot: vault }
    );

    assert.equal(result.isError, false);
    assert.ok(result.content[0].text.includes("no files matched"));
  } finally { cleanup(vault); }
});

test("execute(): rejects search path outside vault", async () => {
  const vault = makeVault();
  try {
    const result = await Glob.execute(
      { pattern: "*.md", path: "../../../etc" },
      { vaultRoot: vault }
    );
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.toLowerCase().includes("outside"));
  } finally { cleanup(vault); }
});

test("execute(): rejects missing pattern parameter", async () => {
  const vault = makeVault();
  try {
    const result = await Glob.execute({}, { vaultRoot: vault });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.toLowerCase().includes("pattern"));
  } finally { cleanup(vault); }
});

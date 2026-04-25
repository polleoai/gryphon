/**
 * Tests for the Grep tool. Grep doesn't expose helpers like Glob does
 * (its internals are mostly Node fs walking + RegExp), so all tests
 * here exercise the execute() entry point against a temp vault.
 *
 * Run with: npm test
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Grep = require("../src/providers/anthropic-api/tools/grep");

function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-grep-test-"));
  return fs.realpathSync(dir);
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function seed(vault, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(vault, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// ── Output mode: files_with_matches (default) ───────────────────────────

test("default output mode lists files with at least one match", async () => {
  const vault = makeVault();
  try {
    seed(vault, {
      "a.md": "hello world",
      "b.md": "goodbye world",
      "c.md": "no matches here",
    });
    const result = await Grep.execute(
      { pattern: "world" },
      { vaultRoot: vault }
    );
    assert.equal(result.isError, false);
    const text = result.content[0].text;
    assert.ok(text.includes("a.md"));
    assert.ok(text.includes("b.md"));
    assert.ok(!text.includes("c.md"));
  } finally { cleanup(vault); }
});

test("returns 'no matches' when nothing matches", async () => {
  const vault = makeVault();
  try {
    seed(vault, { "a.md": "nothing relevant" });
    const result = await Grep.execute(
      { pattern: "missing-string" },
      { vaultRoot: vault }
    );
    assert.equal(result.isError, false);
    assert.ok(result.content[0].text.toLowerCase().includes("no matches"));
  } finally { cleanup(vault); }
});

// ── Output mode: count ──────────────────────────────────────────────────

test("count mode shows match count per file", async () => {
  const vault = makeVault();
  try {
    seed(vault, {
      "a.md": "foo\nfoo\nfoo",        // 3 matches
      "b.md": "foo bar",                // 1 match
      "c.md": "no",                     // 0 matches (excluded)
    });
    const result = await Grep.execute(
      { pattern: "foo", output_mode: "count" },
      { vaultRoot: vault }
    );
    assert.equal(result.isError, false);
    const text = result.content[0].text;
    // Format: <path>: <count>
    assert.match(text, /a\.md: 3/);
    assert.match(text, /b\.md: 1/);
    assert.ok(!text.includes("c.md"));
  } finally { cleanup(vault); }
});

// ── Output mode: content ────────────────────────────────────────────────

test("content mode shows matching lines with line numbers", async () => {
  const vault = makeVault();
  try {
    seed(vault, {
      "a.md": "line one\nfoo bar\nline three",
    });
    const result = await Grep.execute(
      { pattern: "foo", output_mode: "content" },
      { vaultRoot: vault }
    );
    assert.equal(result.isError, false);
    const text = result.content[0].text;
    // Format: <path>:<line_no>: <line>
    assert.match(text, /a\.md:2: foo bar/);
  } finally { cleanup(vault); }
});

// ── Case sensitivity ────────────────────────────────────────────────────

test("default search is case-sensitive", async () => {
  const vault = makeVault();
  try {
    seed(vault, { "a.md": "Hello World" });
    const result = await Grep.execute(
      { pattern: "hello" },
      { vaultRoot: vault }
    );
    assert.ok(result.content[0].text.toLowerCase().includes("no matches"));
  } finally { cleanup(vault); }
});

test("-i flag enables case-insensitive search", async () => {
  const vault = makeVault();
  try {
    seed(vault, { "a.md": "Hello World" });
    const result = await Grep.execute(
      { pattern: "hello", "-i": true },
      { vaultRoot: vault }
    );
    assert.ok(result.content[0].text.includes("a.md"));
  } finally { cleanup(vault); }
});

// ── Regex semantics ─────────────────────────────────────────────────────

test("pattern is a regex, not a literal string", async () => {
  const vault = makeVault();
  try {
    seed(vault, {
      "a.md": "function foo() {}",
      "b.md": "const bar = 1;",
    });
    const result = await Grep.execute(
      { pattern: "function\\s+\\w+" },
      { vaultRoot: vault }
    );
    assert.ok(result.content[0].text.includes("a.md"));
    assert.ok(!result.content[0].text.includes("b.md"));
  } finally { cleanup(vault); }
});

test("invalid regex returns isError: true", async () => {
  const vault = makeVault();
  try {
    seed(vault, { "a.md": "hello" });
    const result = await Grep.execute(
      { pattern: "[invalid" },
      { vaultRoot: vault }
    );
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.toLowerCase().includes("invalid regex"));
  } finally { cleanup(vault); }
});

// ── Glob filter ─────────────────────────────────────────────────────────

test("glob filter narrows to matching filenames", async () => {
  const vault = makeVault();
  try {
    seed(vault, {
      "a.md": "match me",
      "a.txt": "match me",
      "a.js": "match me",
    });
    const result = await Grep.execute(
      { pattern: "match", glob: "*.md" },
      { vaultRoot: vault }
    );
    const text = result.content[0].text;
    assert.ok(text.includes("a.md"));
    assert.ok(!text.includes("a.txt"));
    assert.ok(!text.includes("a.js"));
  } finally { cleanup(vault); }
});

// ── Path scoping ────────────────────────────────────────────────────────

test("path parameter restricts search to a subdirectory", async () => {
  const vault = makeVault();
  try {
    seed(vault, {
      "wiki/a.md": "find me",
      "raw/b.md": "find me",
    });
    const result = await Grep.execute(
      { pattern: "find", path: "wiki" },
      { vaultRoot: vault }
    );
    const text = result.content[0].text;
    assert.ok(text.includes("a.md"));
    assert.ok(!text.includes("b.md"));
  } finally { cleanup(vault); }
});

test("rejects path outside vault", async () => {
  const vault = makeVault();
  try {
    const result = await Grep.execute(
      { pattern: "anything", path: "../../etc" },
      { vaultRoot: vault }
    );
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.toLowerCase().includes("outside"));
  } finally { cleanup(vault); }
});

// ── Ignored directories ─────────────────────────────────────────────────

test("ignores .git, node_modules, .obsidian etc", async () => {
  const vault = makeVault();
  try {
    seed(vault, {
      "a.md": "secret",
      ".git/HEAD": "secret",
      "node_modules/lib.js": "secret",
      ".obsidian/workspace": "secret",
    });
    const result = await Grep.execute(
      { pattern: "secret" },
      { vaultRoot: vault }
    );
    const text = result.content[0].text;
    assert.ok(text.includes("a.md"));
    assert.ok(!text.includes(".git"));
    assert.ok(!text.includes("node_modules"));
    assert.ok(!text.includes(".obsidian"));
  } finally { cleanup(vault); }
});

// ── Input validation ────────────────────────────────────────────────────

test("missing pattern returns isError: true", async () => {
  const vault = makeVault();
  try {
    const result = await Grep.execute({}, { vaultRoot: vault });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.toLowerCase().includes("pattern"));
  } finally { cleanup(vault); }
});

test("empty pattern returns isError: true", async () => {
  const vault = makeVault();
  try {
    const result = await Grep.execute(
      { pattern: "" },
      { vaultRoot: vault }
    );
    assert.equal(result.isError, true);
  } finally { cleanup(vault); }
});

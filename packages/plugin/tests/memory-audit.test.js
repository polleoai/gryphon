/**
 * F3 (v1.7.0) — auto-memory audit and archive.
 *
 * Tests the pure fs-driven helpers against a real temp directory so
 * the rename / mkdir / read-write paths are exercised end to end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  MEMORY_INDEX_NAME,
  ARCHIVE_DIRNAME,
  DEFAULT_ARCHIVE_AGE_DAYS,
  findMemoryDir,
  listMemoryFiles,
  classifyMemoryFiles,
  archiveMemoryFiles,
  unarchiveMemoryFiles,
  updateMemoryIndex,
} = require("../src/memory-audit");

function makeTempMemoryDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-memory-audit-"));
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeMd(dir, name, body, mtimeMs) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, body);
  if (typeof mtimeMs === "number") {
    const secs = mtimeMs / 1000;
    fs.utimesSync(full, secs, secs);
  }
  return full;
}

// ── findMemoryDir ─────────────────────────────────────────────────────

test("findMemoryDir returns null when the memory tree doesn't exist", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-memory-find-"));
  try {
    const out = findMemoryDir({ vaultPath: "/some/vault", homeDir: tmp });
    assert.equal(out, null);
  } finally {
    rmrf(tmp);
  }
});

test("findMemoryDir locates the dir by escaped vault path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-memory-find-"));
  try {
    const vaultPath = "/Users/test/vault";
    const escaped = "-Users-test-vault";
    const expected = path.join(tmp, ".claude", "projects", escaped, "memory");
    fs.mkdirSync(expected, { recursive: true });
    const out = findMemoryDir({ vaultPath, homeDir: tmp });
    assert.equal(out, expected);
  } finally {
    rmrf(tmp);
  }
});

test("findMemoryDir returns null on bad inputs", () => {
  assert.equal(findMemoryDir({ vaultPath: null, homeDir: "/tmp" }), null);
  assert.equal(findMemoryDir({ vaultPath: "/v", homeDir: null }), null);
  assert.equal(findMemoryDir({ vaultPath: "", homeDir: "/tmp" }), null);
});

// ── listMemoryFiles ───────────────────────────────────────────────────

test("listMemoryFiles returns empty when dir doesn't exist", () => {
  assert.deepEqual(listMemoryFiles({ memoryDir: "/no/such/dir" }), []);
});

test("listMemoryFiles includes .md files with size + mtime + age", () => {
  const dir = makeTempMemoryDir();
  try {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    writeMd(dir, "recent.md", "abc", now - 2 * oneDayMs);
    writeMd(dir, "old.md", "abcdefghij", now - 200 * oneDayMs);
    writeMd(dir, "skip.txt", "no-not-markdown");
    writeMd(dir, ".hidden.md", "dotfile");
    fs.mkdirSync(path.join(dir, "subdir"));  // not a file — should be skipped
    const files = listMemoryFiles({ memoryDir: dir, nowMs: now });
    const names = files.map((f) => f.name).sort();
    assert.deepEqual(names, ["old.md", "recent.md"]);
    const recent = files.find((f) => f.name === "recent.md");
    const old = files.find((f) => f.name === "old.md");
    assert.equal(recent.size, 3);
    assert.equal(old.size, 10);
    assert.equal(recent.ageDays, 2);
    assert.equal(old.ageDays, 200);
  } finally {
    rmrf(dir);
  }
});

test("listMemoryFiles sorts by mtime descending (most recent first)", () => {
  const dir = makeTempMemoryDir();
  try {
    const now = Date.now();
    writeMd(dir, "a.md", "x", now - 30 * 24 * 60 * 60 * 1000);
    writeMd(dir, "b.md", "x", now - 1 * 24 * 60 * 60 * 1000);
    writeMd(dir, "c.md", "x", now - 5 * 24 * 60 * 60 * 1000);
    const files = listMemoryFiles({ memoryDir: dir, nowMs: now });
    assert.deepEqual(files.map((f) => f.name), ["b.md", "c.md", "a.md"]);
  } finally {
    rmrf(dir);
  }
});

// ── classifyMemoryFiles ───────────────────────────────────────────────

test("classifyMemoryFiles splits by age threshold", () => {
  const files = [
    { name: "MEMORY.md", ageDays: 0 },
    { name: "very-old.md", ageDays: 200 },
    { name: "recent.md", ageDays: 5 },
    { name: "borderline.md", ageDays: 90 },
  ];
  const { candidates, recent } = classifyMemoryFiles(files);
  assert.deepEqual(candidates.map((f) => f.name).sort(), ["borderline.md", "very-old.md"]);
  assert.deepEqual(recent.map((f) => f.name).sort(), ["MEMORY.md", "recent.md"]);
});

test("classifyMemoryFiles never treats MEMORY.md as a candidate", () => {
  // Even when ancient, the index file holds the link map for the
  // entire memory tree — archiving it would orphan every link.
  const files = [{ name: "MEMORY.md", ageDays: 5000 }];
  const { candidates, recent } = classifyMemoryFiles(files);
  assert.equal(candidates.length, 0);
  assert.equal(recent.length, 1);
});

test("classifyMemoryFiles respects custom ageDaysThreshold", () => {
  const files = [
    { name: "a.md", ageDays: 30 },
    { name: "b.md", ageDays: 60 },
  ];
  const out = classifyMemoryFiles(files, { ageDaysThreshold: 45 });
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].name, "b.md");
});

// ── archiveMemoryFiles + unarchiveMemoryFiles ─────────────────────────

test("archiveMemoryFiles moves files into memory-archive/", () => {
  const dir = makeTempMemoryDir();
  try {
    const p1 = writeMd(dir, "old-1.md", "body1");
    const p2 = writeMd(dir, "old-2.md", "body2");
    const moved = archiveMemoryFiles({
      memoryDir: dir,
      files: [{ name: "old-1.md", path: p1 }, { name: "old-2.md", path: p2 }],
    });
    assert.equal(moved.length, 2);
    const archDir = path.join(dir, ARCHIVE_DIRNAME);
    assert.ok(fs.existsSync(path.join(archDir, "old-1.md")));
    assert.ok(fs.existsSync(path.join(archDir, "old-2.md")));
    assert.ok(!fs.existsSync(p1));
    assert.ok(!fs.existsSync(p2));
  } finally {
    rmrf(dir);
  }
});

test("archiveMemoryFiles refuses to archive MEMORY.md", () => {
  const dir = makeTempMemoryDir();
  try {
    const indexPath = writeMd(dir, "MEMORY.md", "# index");
    const moved = archiveMemoryFiles({
      memoryDir: dir,
      files: [{ name: "MEMORY.md", path: indexPath }],
    });
    assert.equal(moved.length, 0);
    assert.ok(fs.existsSync(indexPath));  // still there
  } finally {
    rmrf(dir);
  }
});

test("archiveMemoryFiles skips per-file move failures and reports successes", () => {
  const dir = makeTempMemoryDir();
  try {
    const real = writeMd(dir, "real.md", "x");
    const ghost = path.join(dir, "ghost.md");  // doesn't exist
    const moved = archiveMemoryFiles({
      memoryDir: dir,
      files: [
        { name: "real.md", path: real },
        { name: "ghost.md", path: ghost },
      ],
    });
    assert.equal(moved.length, 1);
    assert.equal(moved[0].name, "real.md");
  } finally {
    rmrf(dir);
  }
});

test("unarchiveMemoryFiles restores moves back to the memory dir", () => {
  const dir = makeTempMemoryDir();
  try {
    const p = writeMd(dir, "old.md", "x");
    const moved = archiveMemoryFiles({
      memoryDir: dir, files: [{ name: "old.md", path: p }],
    });
    assert.equal(moved.length, 1);
    assert.ok(!fs.existsSync(p));
    const restored = unarchiveMemoryFiles(moved);
    assert.equal(restored.length, 1);
    assert.ok(fs.existsSync(p));
    assert.ok(!fs.existsSync(path.join(dir, ARCHIVE_DIRNAME, "old.md")));
  } finally {
    rmrf(dir);
  }
});

// ── updateMemoryIndex ─────────────────────────────────────────────────

test("updateMemoryIndex comments out lines that link to archived files", () => {
  const dir = makeTempMemoryDir();
  try {
    const indexBody = [
      "# MEMORY",
      "",
      "- [Old thing](old-thing.md) — hook line",
      "- [Recent](recent.md) — hook line",
      "- [[archived-wiki]] — wikilink form",
      "- [[fresh-wiki]] — wikilink form",
    ].join("\n");
    writeMd(dir, MEMORY_INDEX_NAME, indexBody);
    const r = updateMemoryIndex({
      memoryDir: dir,
      archivedNames: ["old-thing.md", "archived-wiki.md"],
    });
    assert.equal(r.commented, 2);
    const updated = fs.readFileSync(path.join(dir, MEMORY_INDEX_NAME), "utf8");
    assert.match(updated, /<!-- \[gryphon-archived] - \[Old thing]\(old-thing\.md\)/);
    assert.match(updated, /<!-- \[gryphon-archived] - \[\[archived-wiki]]/);
    assert.match(updated, /^- \[Recent]\(recent\.md\)/m);  // untouched
  } finally {
    rmrf(dir);
  }
});

test("updateMemoryIndex uncomments only lines for restored files", () => {
  const dir = makeTempMemoryDir();
  try {
    const indexBody = [
      "# MEMORY",
      "<!-- [gryphon-archived] - [A](a.md) — hook -->",
      "<!-- [gryphon-archived] - [B](b.md) — hook -->",
    ].join("\n");
    writeMd(dir, MEMORY_INDEX_NAME, indexBody);
    const r = updateMemoryIndex({
      memoryDir: dir,
      archivedNames: [],
      restoredNames: ["a.md"],
    });
    assert.equal(r.uncommented, 1);
    const updated = fs.readFileSync(path.join(dir, MEMORY_INDEX_NAME), "utf8");
    assert.match(updated, /^- \[A]\(a\.md\)/m);
    assert.match(updated, /<!-- \[gryphon-archived] - \[B]\(b\.md\)/);
  } finally {
    rmrf(dir);
  }
});

test("updateMemoryIndex is a no-op when MEMORY.md is missing", () => {
  const dir = makeTempMemoryDir();
  try {
    const r = updateMemoryIndex({
      memoryDir: dir,
      archivedNames: ["anything.md"],
    });
    assert.deepEqual(r, { commented: 0, uncommented: 0 });
  } finally {
    rmrf(dir);
  }
});

test("DEFAULT_ARCHIVE_AGE_DAYS exposes 90 as the public default", () => {
  // Pinned so external consumers (or future settings UI) reference the
  // same constant without hard-coding 90.
  assert.equal(DEFAULT_ARCHIVE_AGE_DAYS, 90);
});

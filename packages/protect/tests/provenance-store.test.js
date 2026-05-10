/**
 * ProvenanceStore tests (v0.6.0 Stage 6).
 *
 * Covers: atomic persistence, reload-from-disk survival, lint semantics,
 * path key normalisation, tolerant handling of missing + malformed
 * store files.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  ProvenanceStore,
  _normaliseKey,
} = require("../src/provenance-store");

// ── helpers ────────────────────────────────────────────────────────────

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-prov-test-"));
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ── key normalisation ──────────────────────────────────────────────────

test("_normaliseKey converts Windows separators to POSIX", () => {
  assert.equal(_normaliseKey("notes\\sub\\file.md"), "notes/sub/file.md");
});

test("_normaliseKey strips leading slashes", () => {
  assert.equal(_normaliseKey("/notes/file.md"), "notes/file.md");
});

test("_normaliseKey returns null for empty / non-string", () => {
  assert.equal(_normaliseKey(""), null);
  assert.equal(_normaliseKey("   "), null);
  assert.equal(_normaliseKey(null), null);
  assert.equal(_normaliseKey(42), null);
});

// ── lifecycle ──────────────────────────────────────────────────────────

test("empty store reports no tags before any add", () => {
  const dir = tempDir();
  try {
    const store = new ProvenanceStore(dir);
    assert.equal(store.size(), 0);
    assert.equal(store.has("notes/x.md"), false);
    assert.equal(store.get("notes/x.md"), null);
  } finally { rmrf(dir); }
});

test("add persists a tag to disk with the required metadata fields", () => {
  const dir = tempDir();
  try {
    const store = new ProvenanceStore(dir);
    store.add("notes/x.md", {
      source: "Write-after-WebFetch",
      sourceUrl: "https://example.com/page",
      sessionId: "s1",
    });
    assert.ok(store.has("notes/x.md"));
    const got = store.get("notes/x.md");
    assert.equal(got.source, "Write-after-WebFetch");
    assert.equal(got.sourceUrl, "https://example.com/page");
    assert.equal(got.sessionId, "s1");
    assert.match(got.taggedAt, /^\d{4}-\d{2}-\d{2}T/);

    const raw = JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8"));
    assert.equal(raw.paths["notes/x.md"].source, "Write-after-WebFetch");
  } finally { rmrf(dir); }
});

test("tags survive plugin reload (fresh store instance reads from disk)", () => {
  const dir = tempDir();
  try {
    const s1 = new ProvenanceStore(dir);
    s1.add("fetched/page.html", { source: "WebFetch", sessionId: "s1" });

    const s2 = new ProvenanceStore(dir);
    assert.ok(s2.has("fetched/page.html"));
    assert.equal(s2.get("fetched/page.html").source, "WebFetch");
  } finally { rmrf(dir); }
});

test("add requires a source field", () => {
  const dir = tempDir();
  try {
    const store = new ProvenanceStore(dir);
    assert.throws(() => store.add("x.md", {}), /source required/);
    assert.throws(() => store.add("x.md", null), /metadata must be an object/);
  } finally { rmrf(dir); }
});

test("remove drops an entry and persists", () => {
  const dir = tempDir();
  try {
    const store = new ProvenanceStore(dir);
    store.add("a.md", { source: "WebFetch" });
    store.add("b.md", { source: "WebFetch" });
    store.remove("a.md");
    assert.equal(store.has("a.md"), false);
    assert.equal(store.has("b.md"), true);

    const fresh = new ProvenanceStore(dir);
    assert.equal(fresh.has("a.md"), false);
    assert.equal(fresh.has("b.md"), true);
  } finally { rmrf(dir); }
});

test("clear empties the store", () => {
  const dir = tempDir();
  try {
    const store = new ProvenanceStore(dir);
    store.add("a.md", { source: "WebFetch" });
    store.add("b.md", { source: "Bash-network" });
    store.clear();
    assert.equal(store.size(), 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8")).paths
      ? Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8")).paths).length
      : 0, 0);
  } finally { rmrf(dir); }
});

test("list returns all entries", () => {
  const dir = tempDir();
  try {
    const store = new ProvenanceStore(dir);
    store.add("a.md", { source: "WebFetch" });
    store.add("b.md", { source: "Bash-network" });
    const list = store.list();
    assert.equal(list.length, 2);
    const paths = list.map((e) => e.path).sort();
    assert.deepEqual(paths, ["a.md", "b.md"]);
  } finally { rmrf(dir); }
});

// ── lint ───────────────────────────────────────────────────────────────

test("lint drops entries for files that no longer exist", () => {
  const dir = tempDir();  // serves as both pluginDir and vaultRoot in test
  try {
    // Create one existing file, one ghost
    const realFile = "live.md";
    fs.writeFileSync(path.join(dir, realFile), "content");
    const store = new ProvenanceStore(dir);
    store.add(realFile, { source: "WebFetch" });
    store.add("ghost.md", { source: "WebFetch" });

    const { removed } = store.lint(dir);
    assert.deepEqual(removed, ["ghost.md"]);
    assert.ok(store.has(realFile));
    assert.equal(store.has("ghost.md"), false);
  } finally { rmrf(dir); }
});

test("lint with nothing to remove is a no-op and doesn't rewrite needlessly", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "a.md"), "hi");
    const store = new ProvenanceStore(dir);
    store.add("a.md", { source: "WebFetch" });

    const before = fs.statSync(path.join(dir, "provenance.json")).mtimeMs;
    // Sleep a beat so mtime would differ if we rewrote
    const until = Date.now() + 20;
    while (Date.now() < until) { /* spin */ }
    const { removed } = store.lint(dir);
    assert.deepEqual(removed, []);
    const after = fs.statSync(path.join(dir, "provenance.json")).mtimeMs;
    assert.equal(before, after, "lint with no removals must not rewrite the file");
  } finally { rmrf(dir); }
});

// ── tolerance for missing / malformed storage ──────────────────────────

test("missing provenance.json is treated as empty, no throw", () => {
  const dir = tempDir();
  try {
    const store = new ProvenanceStore(dir);
    assert.equal(store.size(), 0);
    assert.equal(fs.existsSync(path.join(dir, "provenance.json")), false);
  } finally { rmrf(dir); }
});

test("malformed provenance.json is tolerated (empty in-memory, file not overwritten)", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "provenance.json"), "<<not json>>");
    const store = new ProvenanceStore(dir);
    assert.equal(store.size(), 0);
    // The corrupt file must be left for the user to inspect.
    assert.equal(fs.readFileSync(path.join(dir, "provenance.json"), "utf8"), "<<not json>>");
    // Round-8 F5: load failure must surface, and writes must be blocked.
    assert.equal(store.isLoadFailed(), true);
    assert.match(store.loadErrorMessage(), /JSON|json/);
    assert.throws(
      () => store.add("a.md", { source: "WebFetch" }),
      /provenance store write blocked/,
      "must refuse to write while load is in failed state",
    );
    // The on-disk corrupt file MUST still be there — never overwritten.
    assert.equal(fs.readFileSync(path.join(dir, "provenance.json"), "utf8"), "<<not json>>");
  } finally { rmrf(dir); }
});

test("R8 F5: unreadable provenance.json blocks writes (no silent data loss)", () => {
  // Simulate an EACCES-style unreadable file by chmod 000. Then attempt
  // an add(); it MUST throw rather than silently overwriting the disk
  // file with empty state.
  const dir = tempDir();
  try {
    const file = path.join(dir, "provenance.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      paths: { "important.md": { source: "WebFetch", taggedAt: "2026-04-01T00:00:00.000Z" } },
    }));
    const originalContent = fs.readFileSync(file, "utf8");
    // Skip on Windows (chmod 000 isn't a no-read on NTFS).
    if (process.platform === "win32") return;
    fs.chmodSync(file, 0o000);
    try {
      const store = new ProvenanceStore(dir);
      assert.equal(store.isLoadFailed(), true, "load should have failed");
      assert.throws(
        () => store.add("new.md", { source: "WebFetch" }),
        /write blocked/,
        "add() must refuse to overwrite an unreadable existing file",
      );
    } finally {
      // Restore so the file can be removed by rmrf.
      fs.chmodSync(file, 0o600);
    }
    // The pre-existing data MUST still be on disk verbatim.
    assert.equal(fs.readFileSync(file, "utf8"), originalContent);
  } finally { rmrf(dir); }
});

test("R8 F8: stale .tmp files older than 60s are swept on load", () => {
  const dir = tempDir();
  try {
    const stalePath = path.join(dir, "provenance.json.99999.deadbeef.tmp");
    const freshPath = path.join(dir, "provenance.json.99999.feedface.tmp");
    fs.writeFileSync(stalePath, "leftover");
    fs.writeFileSync(freshPath, "concurrent writer");
    // Backdate the stale file so it's older than the 60s cutoff.
    const oldTime = (Date.now() - 120_000) / 1000;
    fs.utimesSync(stalePath, oldTime, oldTime);
    const store = new ProvenanceStore(dir);
    store.load();  // triggers _sweepStaleTmpFiles
    assert.equal(fs.existsSync(stalePath), false, "old .tmp should be unlinked");
    // Recent .tmp must NOT be touched (could be a concurrent writer).
    assert.equal(fs.existsSync(freshPath), true, "recent .tmp must be preserved");
  } finally { rmrf(dir); }
});

test("old-version provenance.json loads without error (forward-compat)", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "provenance.json"), JSON.stringify({
      version: 0,  // older
      paths: { "legacy.md": { source: "WebFetch", taggedAt: "2025-01-01T00:00:00.000Z" } },
    }));
    const store = new ProvenanceStore(dir);
    assert.ok(store.has("legacy.md"));
  } finally { rmrf(dir); }
});

// ── path handling ──────────────────────────────────────────────────────

test("lookups normalise Windows path separators", () => {
  const dir = tempDir();
  try {
    const store = new ProvenanceStore(dir);
    store.add("notes/sub/x.md", { source: "WebFetch" });
    assert.ok(store.has("notes\\sub\\x.md"));  // backslashes normalise
    assert.ok(store.has("/notes/sub/x.md"));    // leading slash normalised
  } finally { rmrf(dir); }
});

// ── atomic write ───────────────────────────────────────────────────────

test("atomic write: no stray .tmp file left after a successful add", () => {
  const dir = tempDir();
  try {
    const store = new ProvenanceStore(dir);
    store.add("a.md", { source: "WebFetch" });
    const stray = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.equal(stray.length, 0, `found .tmp leftovers: ${stray.join(", ")}`);
  } finally { rmrf(dir); }
});

// ── multi-instance concurrency (reload-before-mutate) ───────────────────

test("add() reloads disk state before mutating so concurrent-instance tags survive", () => {
  // Simulates two Obsidian windows sharing a vault. Each has its own
  // store instance; they race to add different tags. Without
  // reload-before-mutate, the second add clobbers the first.
  const dir = tempDir();
  try {
    const instanceA = new ProvenanceStore(dir);
    const instanceB = new ProvenanceStore(dir);

    // Prime both instances (lazy load on first call).
    assert.equal(instanceA.size(), 0);
    assert.equal(instanceB.size(), 0);

    // A adds a tag. Writes to disk.
    instanceA.add("from-a.md", { source: "WebFetch", sessionId: "sA" });
    // B adds a different tag. Its in-memory state is stale (thinks the
    // store is empty) but the reload-before-mutate step picks up A's
    // write, so B persists {from-a.md, from-b.md} rather than just
    // {from-b.md}.
    instanceB.add("from-b.md", { source: "WebFetch", sessionId: "sB" });

    // Inspect disk directly — both tags must be present.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8"));
    assert.ok(onDisk.paths["from-a.md"], "A's tag must survive B's add");
    assert.ok(onDisk.paths["from-b.md"], "B's tag must be persisted");
    assert.equal(Object.keys(onDisk.paths).length, 2);

    // Each instance's public API should also see both tags after a
    // fresh operation (which triggers another reload).
    const instanceC = new ProvenanceStore(dir);
    assert.ok(instanceC.has("from-a.md"));
    assert.ok(instanceC.has("from-b.md"));
  } finally { rmrf(dir); }
});

test("remove() and clear() also reload disk state before mutating", () => {
  const dir = tempDir();
  try {
    const A = new ProvenanceStore(dir);
    const B = new ProvenanceStore(dir);
    // Load both (so _loaded = true on each).
    A.list();
    B.list();
    // A adds two entries.
    A.add("x.md", { source: "WebFetch" });
    A.add("y.md", { source: "WebFetch" });
    // B's in-memory state is stale here. Calling remove("x.md") should
    // reload first, pick up both entries, then delete x.md and
    // persist {y.md}. Without reload-before-mutate, B would persist {}.
    B.remove("x.md");
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "provenance.json"), "utf8"));
    assert.ok(!onDisk.paths["x.md"], "x.md should be removed");
    assert.ok(onDisk.paths["y.md"], "y.md must survive B's remove");
  } finally { rmrf(dir); }
});

// ── Round-14 Q4: cross-process lockfile under contention ──────────────

test("Q4: 2 concurrent worker processes each add 50 distinct tags → all 100 survive", async () => {
  const { spawn } = require("child_process");
  const dir = tempDir();
  try {
    const worker = path.join(__dirname, "..", "tests", "fixtures", "provenance-worker.js");
    // Worker file created below; if it doesn't exist, inline its source via eval-on-stdin.
    const WORKER_SRC = `
const { ProvenanceStore } = require(${JSON.stringify(path.join(__dirname, "..", "src", "provenance-store"))});
// argv layout under \`node -e script arg1 arg2 arg3\`:
//   [0]=node, [1]=arg1, ...  (no [eval] placeholder in modern Node).
const dir = process.argv[1];
const wid = process.argv[2];
const iter = Number(process.argv[3]);
const store = new ProvenanceStore(dir);
for (let i = 0; i < iter; i++) store.add(\`\${wid}-\${i}.md\`, { source: "race-test" });
`;
    const runOne = (wid, iter) => new Promise((resolve) => {
      // No "--" before script args — node passes remaining argv after -e script.
      const c = spawn(process.execPath, ["-e", WORKER_SRC, dir, wid, String(iter)],
        { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      c.stderr.on("data", (d) => err += d);
      c.on("exit", (code) => resolve({ code, err }));
    });
    const results = await Promise.all([runOne("A", 50), runOne("B", 50)]);
    for (const r of results) {
      assert.equal(r.code, 0, `worker failed: exit=${r.code} stderr=${r.err}`);
    }

    const { ProvenanceStore } = require("../src/provenance-store");
    const verify = new ProvenanceStore(dir);
    verify.load();
    const size = verify.size();
    assert.equal(size, 100,
      `expected 100 tags under concurrency with lockfile, got ${size} (lost ${100 - size})`);
  } finally { rmrf(dir); }
});

test("Q4: stale lockfile older than LOCK_STALE_MS is stolen", () => {
  const dir = tempDir();
  try {
    const lockFile = path.join(dir, "provenance.json.lock");
    // Create a "stale" lockfile with old mtime (20s ago > LOCK_STALE_MS).
    fs.writeFileSync(lockFile, "99999\n2000-01-01T00:00:00Z\n");
    fs.utimesSync(lockFile, Date.now() / 1000 - 20, Date.now() / 1000 - 20);

    const { ProvenanceStore } = require("../src/provenance-store");
    const store = new ProvenanceStore(dir);
    // add() must steal the stale lock and succeed rather than time out.
    store.add("recovered.md", { source: "after-stale-lock" });
    assert.equal(store.size(), 1);
    // Lock should be released after the mutation.
    assert.ok(!fs.existsSync(lockFile), "lockfile must be released after mutation");
  } finally { rmrf(dir); }
});

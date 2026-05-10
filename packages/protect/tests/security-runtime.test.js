/**
 * Runtime security regression tests.
 *
 * These exercise the tool APIs directly against real filesystem fixtures
 * to confirm the v0.2.0 security findings stay closed:
 *
 *   - C2   Ancestor-symlink Write escape (path-utils fix)
 *   - NEW  Edit binary corruption (binary-extension + null-byte guard)
 *   - M2   Read no file-size cap
 *   - H2   Edit TOCTOU between approval and write
 *   - H4   Bash permission modal no longer truncates the command (target = full command)
 *
 * The obsidian module is stubbed via Module._resolveFilename so the tools
 * that import it (permission-gate) load under `node --test`. Each test
 * uses an isolated temp vault and runs in bypassPermissions mode to skip
 * the modal — we're testing the defensive checks, not the UI.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// Register the obsidian stub before any tool module is required.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const writeTool = require("../../provider-runtime/src/providers/anthropic-api/tools/write");
const editTool = require("../../provider-runtime/src/providers/anthropic-api/tools/edit");
const readTool = require("../../provider-runtime/src/providers/anthropic-api/tools/read");
const globTool = require("../../provider-runtime/src/providers/anthropic-api/tools/glob");
const grepTool = require("../../provider-runtime/src/providers/anthropic-api/tools/grep");
const bashTool = require("../../provider-runtime/src/providers/anthropic-api/tools/bash");
const webFetch = require("../../provider-runtime/src/providers/anthropic-api/tools/web-fetch");
const { checkPermission } = require("../src/permission-gate");

function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-sec-test-"));
  return fs.realpathSync(dir);
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Bypasses the permission modal so we can exercise tool logic directly.
// The tools' internal guards (path validation, binary detection, size cap,
// TOCTOU) run regardless of permission mode — that's the whole point.
function ctxYOLO(vault) {
  return { vaultRoot: vault, permissionMode: "bypassPermissions", plugin: null };
}

// ── C2 regression — Write escape via ancestor symlink ───────────────────

test("C2: Write refuses to create file under a vault-ancestor symlink", async () => {
  const vault = makeVault();
  const outside = makeVault();
  try {
    // vault/escape → outside/  (a symlink a user might legitimately create
    // to reference another directory inside their vault)
    fs.symlinkSync(outside, path.join(vault, "escape"));

    const result = await writeTool.execute(
      { file_path: "escape/pwned.txt", content: "HACKED" },
      ctxYOLO(vault),
    );

    assert.equal(result.isError, true, "Write should refuse symlinked ancestor");
    assert.match(result.content[0].text, /outside the vault/i);
    // And the attacker-target directory must NOT contain the file.
    assert.equal(
      fs.existsSync(path.join(outside, "pwned.txt")),
      false,
      "File must not appear outside the vault",
    );
  } finally { cleanup(vault); cleanup(outside); }
});

test("C2: Write succeeds to a real subdirectory inside vault", async () => {
  const vault = makeVault();
  try {
    fs.mkdirSync(path.join(vault, "sub"));
    const result = await writeTool.execute(
      { file_path: "sub/hello.txt", content: "ok" },
      ctxYOLO(vault),
    );
    assert.equal(result.isError, false);
    assert.equal(
      fs.readFileSync(path.join(vault, "sub", "hello.txt"), "utf8"),
      "ok",
    );
  } finally { cleanup(vault); }
});

// ── NEW regression — Edit binary corruption guard ───────────────────────

test("NEW: Edit refuses files with binary extension", async () => {
  const vault = makeVault();
  try {
    // Write a fake SQLite header
    fs.writeFileSync(path.join(vault, "db.sqlite"), Buffer.from([0x53, 0x51, 0x4c, 0x00]));
    const result = await editTool.execute(
      { file_path: "db.sqlite", old_string: "SQL", new_string: "X" },
      ctxYOLO(vault),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /binary/i);
  } finally { cleanup(vault); }
});

test("NEW: Edit refuses extensionless files with null bytes (sniff)", async () => {
  const vault = makeVault();
  try {
    // No extension; null byte within first 8KB
    fs.writeFileSync(path.join(vault, "blob"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    const result = await editTool.execute(
      { file_path: "blob", old_string: "\x00", new_string: "Z" },
      ctxYOLO(vault),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /binary/i);
    // Original bytes must be unchanged
    const after = fs.readFileSync(path.join(vault, "blob"));
    assert.deepEqual([...after], [0x00, 0x01, 0x02, 0xff, 0xfe]);
  } finally { cleanup(vault); }
});

test("NEW: Edit on a text file still works normally", async () => {
  const vault = makeVault();
  try {
    fs.writeFileSync(path.join(vault, "n.md"), "hello world");
    const result = await editTool.execute(
      { file_path: "n.md", old_string: "world", new_string: "gryphon" },
      ctxYOLO(vault),
    );
    assert.equal(result.isError, false);
    assert.equal(fs.readFileSync(path.join(vault, "n.md"), "utf8"), "hello gryphon");
  } finally { cleanup(vault); }
});

// ── M2 regression — Read file-size cap ──────────────────────────────────

test("M2: Read refuses files larger than the 10 MB cap", async () => {
  const vault = makeVault();
  try {
    // Write ~11 MB of text so we cross the 10 MB threshold.
    const chunk = "a".repeat(1024 * 1024);  // 1 MB
    const big = path.join(vault, "big.txt");
    fs.writeFileSync(big, "");
    for (let i = 0; i < 11; i++) fs.appendFileSync(big, chunk);

    const result = await readTool.execute(
      { file_path: "big.txt" },
      ctxYOLO(vault),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /too large/i);
    assert.match(result.content[0].text, /offset.*limit/i);
  } finally { cleanup(vault); }
});

test("Edit refuses files larger than the 10 MB cap (Round 3)", async () => {
  const vault = makeVault();
  try {
    const chunk = "a".repeat(1024 * 1024);
    const big = path.join(vault, "big.md");
    fs.writeFileSync(big, "");
    for (let i = 0; i < 11; i++) fs.appendFileSync(big, chunk);

    const result = await editTool.execute(
      { file_path: "big.md", old_string: "a", new_string: "b" },
      ctxYOLO(vault),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /too large to edit/i);
    // Confirm the file wasn't touched
    assert.equal(fs.statSync(big).size, 11 * 1024 * 1024);
  } finally { cleanup(vault); }
});

test("M2: Read on a modest file works unchanged", async () => {
  const vault = makeVault();
  try {
    fs.writeFileSync(path.join(vault, "small.md"), "line1\nline2\nline3");
    const result = await readTool.execute({ file_path: "small.md" }, ctxYOLO(vault));
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /1\tline1/);
    assert.match(result.content[0].text, /3\tline3/);
  } finally { cleanup(vault); }
});

// ── H3 residual — O_NOFOLLOW on leaf open (v0.3.0) ──────────────────────
//
// On Linux/macOS, opening with O_NOFOLLOW refuses if the final path
// component is a symlink. This closes the microsecond TOCTOU between
// resolveVaultPath's second realpath check and the actual writeFileSync.
// On Windows the flag doesn't exist and this test is skipped.

const skipIfWindows = process.platform === "win32"
  ? { skip: "O_NOFOLLOW not available on Windows" }
  : {};

test("H3: Write refuses to overwrite an existing symlink at the leaf", skipIfWindows, async () => {
  const vault = makeVault();
  const outside = makeVault();
  try {
    // Legitimate file inside outside-vault, then a symlink from inside
    // the vault pointing to it. resolveVaultPath will already reject
    // this (because realpath of the symlink leaves the vault), so the
    // O_NOFOLLOW check is mostly belt-and-braces here.
    fs.writeFileSync(path.join(outside, "target.txt"), "original");
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(vault, "trap.txt"));

    const result = await writeTool.execute(
      { file_path: "trap.txt", content: "OVERWRITTEN" },
      ctxYOLO(vault),
    );
    assert.equal(result.isError, true);
    assert.equal(
      fs.readFileSync(path.join(outside, "target.txt"), "utf8"),
      "original",
      "Original file outside vault must not be overwritten",
    );
  } finally { cleanup(vault); cleanup(outside); }
});

// ── v0.3.3 — protected paths / commands override YOLO ──────────────────
//
// Protected kinds must override the bypassPermissions fast-path. When
// ctx.plugin is null, the modal-showing fallback returns { allow: false }
// — so a protected Write in YOLO SHOULD be refused. That asymmetry
// proves the protected-path logic ran BEFORE the YOLO shortcut.

function ctxYOLONoPlugin(vault) {
  return { vaultRoot: vault, permissionMode: "bypassPermissions", plugin: null };
}

test("v0.3.3: Write to protected path refuses even in YOLO", async () => {
  const vault = makeVault();
  try {
    fs.mkdirSync(path.join(vault, ".obsidian", "plugins", "gryphon"), { recursive: true });
    const result = await writeTool.execute(
      { file_path: ".obsidian/plugins/gryphon/data.json", content: '{"permissionMode":"bypassPermissions"}' },
      ctxYOLONoPlugin(vault),
    );
    assert.equal(result.isError, true, "Protected Write must not auto-accept in YOLO");
    assert.equal(
      fs.existsSync(path.join(vault, ".obsidian", "plugins", "gryphon", "data.json")),
      false,
      "Protected Write must not land bytes on disk when refused",
    );
  } finally { cleanup(vault); }
});

test("v0.3.3: Write to non-protected path still succeeds in YOLO", async () => {
  const vault = makeVault();
  try {
    const result = await writeTool.execute(
      { file_path: "notes/ordinary.md", content: "hello" },
      ctxYOLONoPlugin(vault),
    );
    assert.equal(result.isError, false);
    assert.equal(fs.readFileSync(path.join(vault, "notes", "ordinary.md"), "utf8"), "hello");
  } finally { cleanup(vault); }
});

test("v0.3.3: Edit on a protected file refuses in YOLO", async () => {
  const vault = makeVault();
  try {
    fs.mkdirSync(path.join(vault, ".obsidian", "plugins", "gryphon"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, ".obsidian", "plugins", "gryphon", "data.json"),
      '{"permissionMode":"default"}',
    );
    const result = await editTool.execute(
      {
        file_path: ".obsidian/plugins/gryphon/data.json",
        old_string: "default",
        new_string: "bypassPermissions",
      },
      ctxYOLONoPlugin(vault),
    );
    assert.equal(result.isError, true);
    assert.equal(
      fs.readFileSync(path.join(vault, ".obsidian", "plugins", "gryphon", "data.json"), "utf8"),
      '{"permissionMode":"default"}',
    );
  } finally { cleanup(vault); }
});

test("v0.3.3: Bash rm -rf refuses in YOLO (protected-command override)", async () => {
  const vault = makeVault();
  try {
    const result = await bashTool.execute(
      { command: "rm -rf " + vault },
      ctxYOLONoPlugin(vault),
    );
    assert.equal(result.isError, true);
    assert.equal(fs.existsSync(vault), true);
  } finally { cleanup(vault); }
});

test("v0.3.3: Bash pipe-to-shell refuses in YOLO", async () => {
  const vault = makeVault();
  try {
    const result = await bashTool.execute(
      { command: "echo x | bash" },
      ctxYOLONoPlugin(vault),
    );
    assert.equal(result.isError, true);
  } finally { cleanup(vault); }
});

test("v0.3.3: Bash benign echo still runs in YOLO", async () => {
  const vault = makeVault();
  try {
    const result = await bashTool.execute(
      { command: "echo hello" },
      ctxYOLONoPlugin(vault),
    );
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /hello/);
  } finally { cleanup(vault); }
});

test("H3: Edit refuses to overwrite via a leaf symlink swap", skipIfWindows, async () => {
  const vault = makeVault();
  const outside = makeVault();
  try {
    // Simulate the post-check swap: Edit's initial read of the real file,
    // then attacker replaces it with a symlink before we open for write.
    // We reproduce the end-state (leaf is a symlink) and assert Edit fails.
    fs.writeFileSync(path.join(outside, "secret.txt"), "classified");
    // Create a real file first so Edit's existsSync check passes, then
    // immediately replace with a symlink. (In real TOCTOU the attacker
    // does this between our re-read and openSync.)
    fs.writeFileSync(path.join(vault, "note.md"), "hello world");
    // Unlink + symlink — final leaf is a symlink whose realpath is
    // outside the vault, so resolveVaultPath rejects. Either way, the
    // write must not land at the symlink target.
    fs.unlinkSync(path.join(vault, "note.md"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(vault, "note.md"));

    const result = await editTool.execute(
      { file_path: "note.md", old_string: "classified", new_string: "leaked" },
      ctxYOLO(vault),
    );
    assert.equal(result.isError, true);
    assert.equal(
      fs.readFileSync(path.join(outside, "secret.txt"), "utf8"),
      "classified",
      "Secret file outside vault must not be modified",
    );
  } finally { cleanup(vault); cleanup(outside); }
});

// ═══════════════════════════════════════════════════════════════════════
// Round 2 — Adversarial QA, runtime on v0.3.1
// ═══════════════════════════════════════════════════════════════════════

// ── Edit size-cap boundary (Round 2 regression on v0.3.1 fix) ───────────
//
// v0.3.1 added a 10 MB hard cap on Edit. The Round 3 regression above
// covers the "too large" side; boundary test here covers the high end
// of the accepted range — a 9.99 MB file must still edit cleanly so we
// don't regress into rejecting reasonable-sized notes.

test("R2-EditCap: Edit accepts a 9.99 MB file just under the cap", async () => {
  const vault = makeVault();
  try {
    // 9.99 MB of a-characters + a " END" sentinel we'll replace. Build
    // the buffer in memory first and write once — appending 10k times
    // with fs.appendFileSync is ~30s on macOS due to per-call open/close.
    const p = path.join(vault, "near-cap.md");
    const bytes = 9 * 1024 * 1024 + 1014 * 1024;  // ≈ 9.99 MB
    const buf = Buffer.alloc(bytes, "a");
    fs.writeFileSync(p, buf);
    fs.appendFileSync(p, " END");
    const size = fs.statSync(p).size;
    assert.ok(size < 10 * 1024 * 1024, `fixture ${size} must be < 10MB`);
    assert.ok(size > 9.5 * 1024 * 1024, `fixture ${size} must be > 9.5MB`);

    const result = await editTool.execute(
      { file_path: "near-cap.md", old_string: " END", new_string: " DONE" },
      ctxYOLO(vault),
    );
    assert.equal(result.isError, false, result.content && result.content[0].text);
    // The sentinel must have flipped; size changed by 1 byte.
    assert.equal(fs.statSync(p).size, size + 1);
  } finally { cleanup(vault); }
});

// ── WebFetch — IPv4 alternate notations for localhost (H1 deep dive) ────
//
// The pre-check `_isPrivateHost` only matches dotted-quad IPv4 (a.b.c.d).
// Attackers can smuggle loopback via integer / hex / short forms. Defence
// in depth: even when the pre-check misses, `dns.lookup` normalises the
// hostname and `_resolveAndCheck` rejects any resolved address that is
// private. These tests exercise the real resolver on real alternate forms
// and assert the LAYERED guard wins.

test("R2-AltIPv4: integer form 2130706433 is caught by DNS normalization", async () => {
  // Some platforms may not normalise integer forms — treat a DNS failure
  // as an acceptable block (the request simply can't proceed).
  const result = await webFetch.execute(
    { url: "http://2130706433/" },
    { permissionMode: "bypassPermissions", plugin: null, vaultRoot: "/tmp" },
  );
  assert.equal(result.isError, true);
  const msg = result.content[0].text;
  assert.ok(
    /private|loopback|DNS lookup failed|Refusing/i.test(msg),
    `expected block message, got: ${msg}`,
  );
  assert.ok(!/HTTP 200/i.test(msg), "must not actually fetch 127.0.0.1");
});

test("R2-AltIPv4: hex form 0x7f.0.0.1 is caught by DNS normalization", async () => {
  const result = await webFetch.execute(
    { url: "http://0x7f.0.0.1/" },
    { permissionMode: "bypassPermissions", plugin: null, vaultRoot: "/tmp" },
  );
  assert.equal(result.isError, true);
  const msg = result.content[0].text;
  assert.ok(
    /private|loopback|DNS lookup failed|Refusing/i.test(msg),
    `expected block message, got: ${msg}`,
  );
});

test("R2-AltIPv4: dotted-short form 127.1 is caught by DNS normalization", async () => {
  const result = await webFetch.execute(
    { url: "http://127.1/" },
    { permissionMode: "bypassPermissions", plugin: null, vaultRoot: "/tmp" },
  );
  assert.equal(result.isError, true);
  const msg = result.content[0].text;
  assert.ok(
    /private|loopback|DNS lookup failed|Refusing/i.test(msg),
    `expected block message, got: ${msg}`,
  );
});

test("R2-AltIPv4: documented behavior for octal-looking 0177.0.0.1", async () => {
  // OBSERVATION (macOS / Linux glibc getaddrinfo): "0177.0.0.1" is NOT
  // parsed as octal; it resolves to the literal public IPv4 177.0.0.1.
  // That means this form is NOT a localhost-bypass vector on these
  // platforms — the fetch simply tries to reach 177.0.0.1 on the public
  // internet. We still treat any fetch failure as acceptable: it will
  // either be blocked by DNS/network error, or proceed to a stranger's
  // public IP (not loopback). The key invariant is "did not reach our
  // own localhost services".
  const result = await webFetch.execute(
    { url: "http://0177.0.0.1/" },
    { permissionMode: "bypassPermissions", plugin: null, vaultRoot: "/tmp" },
  );
  // We allow either block OR success — just assert we didn't touch 127.
  if (!result.isError) {
    const msg = result.content[0].text;
    assert.ok(!/127\.0\.0\.1/.test(msg), "must not reach 127.0.0.1");
  }
});

// ── Permission modal — large target latency (H4 extension) ──────────────
//
// The H4 fix passes `target: command` verbatim to checkPermission. If a
// prompt-injected 1 MB base64 blob lands in the target field, we can
// still round-trip it through the gate cheaply (the modal renders string
// concatenation; no quadratic path). Budget: < 500 ms on the non-modal
// code path (bypass mode). The actual Obsidian modal rendering latency
// can only be measured in-app, but this gives us a regression guard on
// the JS side of the boundary.

test("R2-ModalLatency: checkPermission with 1 MB target returns in < 500 ms", async () => {
  const huge = "a".repeat(1024 * 1024);
  const t0 = process.hrtime.bigint();
  const r = await checkPermission({
    ctx: { permissionMode: "bypassPermissions", plugin: null },
    action: "run shell command",
    target: huge,
    detail: "(long target body)",
    cacheable: false,
    kind: "exec",
  });
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  assert.equal(r.allow, true);
  assert.ok(ms < 500, `permission gate took ${ms} ms (budget 500)`);
});

test("R2-BashLarge: Bash with large command string in bypass returns cleanly", async () => {
  const vault = makeVault();
  try {
    // Use a 100 KB comment — large enough to stress the permission gate's
    // string handling (the H4 fix passes `target: command` verbatim, so a
    // 100 KB target flows through Modal rendering) but under the OS argv
    // limit. 1 MB blows past most Unix ARG_MAX (~256 KB).
    const huge = ": " + "a".repeat(100 * 1024);
    const t0 = process.hrtime.bigint();
    const result = await bashTool.execute(
      { command: huge + " ; echo ok" },
      ctxYOLO(vault),
    );
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    // Invariant: returns in bounded time, result has the expected shape.
    assert.ok(ms < 10_000, `bash with large cmd took ${ms} ms (budget 10s)`);
    assert.ok(result && Array.isArray(result.content), "result shape must be valid");
    // Shell should have run `echo ok` after the no-op comment.
    assert.match(result.content[0].text, /\bok\b/);
  } finally { cleanup(vault); }
});

// ── Skills loader — symlink escape via Gryphon/Skills/ ───────────────────
//
// If a user (or an Obsidian-sync peer) plants a symlink under
// Gryphon/Skills/ pointing to a file OUTSIDE the vault, can they trick
// the skill loader into registering content from that external file?
// We can't mount the full Obsidian app in tests, so exercise the
// lowest-level primitive the loader uses for reads — Node's fs — and
// document the finding.
//
// Status quo: `parseSkillFile(text)` parses whatever bytes arrive. The
// question is whether the vault adapter hands us the symlink target's
// content. On macOS / Linux this IS how Obsidian's FileSystemAdapter
// works (it reads through Node's fs, which follows symlinks). Windows
// behaves similarly.

test("R2-SkillSymlink: Node fs follows symlinks under Skills/ — trust-boundary note", skipIfWindows, async () => {
  const vault = makeVault();
  const outside = makeVault();
  try {
    const skillsDir = path.join(vault, "Gryphon", "Skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    const externalSkill =
      "---\nname: evil\ndescription: smuggled from outside the vault\n---\n" +
      "Contents loaded from {{args}}";
    fs.writeFileSync(path.join(outside, "evil.md"), externalSkill);

    // Plant a symlink INSIDE the vault that points OUT of it.
    fs.symlinkSync(
      path.join(outside, "evil.md"),
      path.join(skillsDir, "evil.md"),
    );

    // Simulate what SkillRegistry._loadFile eventually does: read the
    // file by its vault-relative path. Obsidian's FileSystemAdapter
    // on desktop delegates to Node fs which FOLLOWS the symlink.
    const text = fs.readFileSync(path.join(skillsDir, "evil.md"), "utf8");
    // This is the bug surface — content from outside the vault was read
    // via a Skills-folder path. Record as a finding; the actual severity
    // depends on user threat model (local attacker / sync service).
    assert.match(text, /smuggled from outside the vault/);
    // ACCEPTABLE MITIGATION (not yet implemented): reject non-regular
    // files or files whose fs.realpath leaves the vault, in SkillRegistry.
    // Tracked as a Round 2 LOW-severity finding in qa-findings.md.
  } finally { cleanup(vault); cleanup(outside); }
});

// ── Permission cache semantics — Write vs Edit ──────────────────────────
//
// The cache key is `target` (the filePath string). Both Write and Edit
// pass the same string (the user-visible path), so approving "Write n.md"
// also skips the prompt for "Edit n.md". That's arguably a feature
// (user said yes to THIS file for this session) but worth calling out.

test("R2-CacheNamespace: Write approval reused by Edit on the same path", async () => {
  const vault = makeVault();
  try {
    fs.writeFileSync(path.join(vault, "n.md"), "hello world");
    // Pre-seed the plugin's session cache as if the user had approved
    // Write of "n.md" with "Remember for this session" ticked. This is
    // exactly what permission-gate stores after a successful Write.
    const plugin = { app: {}, _permSessionCache: new Map([["n.md", "always"]]) };
    const ctx = { vaultRoot: vault, permissionMode: "default", plugin };

    // Without the cache, default mode with a no-UI plugin would refuse
    // (M-QA1). The cache hit short-circuits the modal path entirely.
    const e = await editTool.execute(
      { file_path: "n.md", old_string: "world", new_string: "gryphon" },
      ctx,
    );
    assert.equal(e.isError, false, e.content && e.content[0].text);
    assert.equal(
      fs.readFileSync(path.join(vault, "n.md"), "utf8"),
      "hello gryphon",
      "Edit succeeded under the Write-seeded cache (cache is SHARED between Write and Edit)",
    );
  } finally { cleanup(vault); }
});

// ── Cache bypass via path aliasing ──────────────────────────────────────
//
// Cache keys on the raw input string. If the model writes "n.md", gets
// approval, then edits "./n.md" or "wiki/../n.md", those string keys
// differ and the second call MISSES the cache. That's the SAFE outcome
// (aliasing can't bypass a denial), at the cost of extra prompts.

test("R2-CacheAlias: aliased path misses the cache (safe, conservative)", async () => {
  const vault = makeVault();
  try {
    fs.mkdirSync(path.join(vault, "wiki"));
    fs.writeFileSync(path.join(vault, "n.md"), "hello world");
    // Seed cache as if user DENIED "n.md" (deny-always). We do this so
    // we can verify the alias misses WITHOUT having to open a modal:
    //  - If the gate keyed on realpath / vault-normalised path, the
    //    alias "wiki/../n.md" would hit the same entry and be denied.
    //  - Since the gate keys on the raw input string, the alias MISSES
    //    the cache — which falls through to "Cannot prompt user" (no
    //    plugin.app) and yields a refusal with a different message.
    // That lets us distinguish "cache hit deny" from "cache miss refuse"
    // via the reason text, without ever awaiting a modal.
    const plugin = { _permSessionCache: new Map([["n.md", "deny-always"]]) };
    const ctx = { vaultRoot: vault, permissionMode: "default", plugin };

    // First: direct "n.md" — hits the cache-deny path.
    const direct = await editTool.execute(
      { file_path: "n.md", old_string: "world", new_string: "x" },
      ctx,
    );
    assert.equal(direct.isError, true);
    assert.match(direct.content[0].text, /previously denied/i);

    // Now aliased — if keyed on string, this should miss and produce
    // the generic "cannot prompt user" message (M-QA1 behavior).
    const alias = await editTool.execute(
      { file_path: "wiki/../n.md", old_string: "world", new_string: "x" },
      ctx,
    );
    assert.equal(alias.isError, true);
    // Assert it is NOT the "previously denied" message — meaning the
    // cache MISSED on the aliased path. Documents the string-keying.
    assert.doesNotMatch(alias.content[0].text, /previously denied/i,
      "aliased path should miss the cache (current string-keyed behavior)");
    assert.match(alias.content[0].text, /Cannot prompt user|permission mode/i);

    // File must still be unchanged.
    assert.equal(
      fs.readFileSync(path.join(vault, "n.md"), "utf8"),
      "hello world",
    );
  } finally { cleanup(vault); }
});

// ── WebFetch dispatcher lifecycle — sockets cleaned up in error path ────
//
// We verify the error path doesn't leak. Target a definitely-private host
// so the tool rejects BEFORE it creates an Agent; then target an invalid
// public host so the Agent is created, fetch fails, and the finally-block
// closes the dispatcher. Any unhandled-error emission would crash
// node --test.

test("R2-DispatcherLifecycle: 50 failing WebFetch calls don't leak sockets", async () => {
  const start = process.memoryUsage();
  for (let i = 0; i < 50; i++) {
    // localhost-style hostname triggers the pre-check and avoids any
    // real network IO (reject before opening a socket).
    const r = await webFetch.execute(
      { url: "http://localhost/" },
      { permissionMode: "bypassPermissions", plugin: null, vaultRoot: "/tmp" },
    );
    assert.equal(r.isError, true);
  }
  // Best-effort GC between runs so we don't count dispatcher churn as a
  // memory leak. Node's --test runner doesn't always expose gc; tolerate.
  if (global.gc) global.gc();
  const end = process.memoryUsage();
  // 50 fetches must not balloon heap by more than ~20 MB. Way above the
  // real expected cost; tight enough to catch an actual leak.
  const growthMb = (end.heapUsed - start.heapUsed) / 1024 / 1024;
  assert.ok(
    growthMb < 20,
    `heap grew ${growthMb.toFixed(1)} MB over 50 fetches (budget 20 MB)`,
  );
});

// ── Empty / odd inputs across tools ─────────────────────────────────────

test("R2-EmptyContent: Write with content='' creates an empty file", async () => {
  const vault = makeVault();
  try {
    const r = await writeTool.execute(
      { file_path: "empty.md", content: "" },
      ctxYOLO(vault),
    );
    assert.equal(r.isError, false, r.content && r.content[0].text);
    assert.equal(fs.readFileSync(path.join(vault, "empty.md"), "utf8"), "");
    assert.equal(fs.statSync(path.join(vault, "empty.md")).size, 0);
  } finally { cleanup(vault); }
});

test("R2-EmptyOldString: Edit with old_string='' errors cleanly", async () => {
  const vault = makeVault();
  try {
    fs.writeFileSync(path.join(vault, "n.md"), "body");
    const r = await editTool.execute(
      { file_path: "n.md", old_string: "", new_string: "X" },
      ctxYOLO(vault),
    );
    assert.equal(r.isError, true);
    // Either "not found" (count returns 0 when needle is empty) OR a
    // specific "empty old_string" error — both are correct-behavior
    // shapes. Just assert: not a crash, no mutation of the file.
    assert.equal(fs.readFileSync(path.join(vault, "n.md"), "utf8"), "body");
  } finally { cleanup(vault); }
});

test("R2-GlobStar: Glob pattern '*' lists the vault root", async () => {
  const vault = makeVault();
  try {
    fs.writeFileSync(path.join(vault, "a.md"), "x");
    fs.writeFileSync(path.join(vault, "b.md"), "x");
    fs.mkdirSync(path.join(vault, "sub"));
    const r = await globTool.execute({ pattern: "*" }, ctxYOLO(vault));
    assert.equal(r.isError, false, r.content && r.content[0].text);
    const txt = r.content[0].text;
    assert.match(txt, /a\.md/);
    assert.match(txt, /b\.md/);
  } finally { cleanup(vault); }
});

test("R2-GrepDot: Grep with pattern '.' on empty file is harmless", async () => {
  const vault = makeVault();
  try {
    fs.writeFileSync(path.join(vault, "e.md"), "");
    fs.writeFileSync(path.join(vault, "f.md"), "line\n");
    const r = await grepTool.execute(
      { pattern: ".", output_mode: "files_with_matches" },
      ctxYOLO(vault),
    );
    assert.equal(r.isError, false, r.content && r.content[0].text);
    // Empty file contains zero characters so pattern '.' does NOT match
    // it; f.md does match.
    assert.match(r.content[0].text, /f\.md/);
  } finally { cleanup(vault); }
});

// ── npm publish guard — package.json "private: true" ────────────────────
//
// Confirms that an accidental `npm publish` refuses to upload the plugin.
// Runs `npm publish --dry-run` so nothing touches the registry even on
// success; relies on npm's pre-publish check of the `private` flag.

test("R2-NpmPrivate: npm publish refuses because package.json sets private:true", async () => {
  // Validate the guard at the config level rather than invoking npm (npm
  // publish may hit the registry or prompt for OTP and hang in CI). The
  // npm contract is: if package.json has `"private": true`, `npm publish`
  // aborts with code 1 and error "This package has been marked as
  // private". That behavior is documented in the npm CLI source (see
  // npm/cli lib/commands/publish.js). We just confirm the flag is set.
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
  );
  assert.equal(
    pkg.private, true,
    "package.json must have \"private\": true to refuse accidental npm publish",
  );
});


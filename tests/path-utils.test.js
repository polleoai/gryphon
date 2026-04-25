/**
 * Security boundary tests for resolveVaultPath().
 *
 * This is the single function standing between a prompt-injected
 * file_path and arbitrary-file-read on the user's machine. Every
 * SDK-mode tool that touches the filesystem routes through it.
 *
 * Run with: node --test tests/
 *
 * No external test framework — uses Node's built-in `node:test` runner
 * (stable since Node 20). Keeps the dependency graph minimal.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolveVaultPath, PathOutsideVaultError } = require("../src/providers/anthropic-api/tools/path-utils");

// Set up an isolated temp vault for each test run. realpathSync is used
// because /tmp on macOS is itself a symlink to /private/tmp; without
// resolving up-front the symlink-escape tests would compare apples to
// oranges and false-pass.
function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-test-vault-"));
  return fs.realpathSync(dir);
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── Allowed paths ──────────────────────────────────────────────────────

test("relative path resolves inside vault", () => {
  const vault = makeVault();
  try {
    fs.writeFileSync(path.join(vault, "note.md"), "hello");
    const resolved = resolveVaultPath("note.md", vault);
    assert.equal(resolved, path.join(vault, "note.md"));
  } finally { cleanup(vault); }
});

test("nested relative path resolves inside vault", () => {
  const vault = makeVault();
  try {
    fs.mkdirSync(path.join(vault, "wiki", "topics"), { recursive: true });
    const resolved = resolveVaultPath("wiki/topics/x.md", vault);
    assert.equal(resolved, path.join(vault, "wiki", "topics", "x.md"));
  } finally { cleanup(vault); }
});

test("absolute path inside vault is accepted", () => {
  const vault = makeVault();
  try {
    fs.writeFileSync(path.join(vault, "a.md"), "");
    const absolute = path.join(vault, "a.md");
    const resolved = resolveVaultPath(absolute, vault);
    assert.equal(resolved, absolute);
  } finally { cleanup(vault); }
});

test("vault root itself resolves to vault root", () => {
  const vault = makeVault();
  try {
    const resolved = resolveVaultPath(".", vault);
    assert.equal(resolved, vault);
  } finally { cleanup(vault); }
});

// ── Path traversal attacks ──────────────────────────────────────────────

test("rejects ../ escape", () => {
  const vault = makeVault();
  try {
    assert.throws(
      () => resolveVaultPath("../escape.txt", vault),
      PathOutsideVaultError,
    );
  } finally { cleanup(vault); }
});

test("rejects deep ../../../ escape", () => {
  const vault = makeVault();
  try {
    assert.throws(
      () => resolveVaultPath("../../../etc/passwd", vault),
      PathOutsideVaultError,
    );
  } finally { cleanup(vault); }
});

test("rejects ../ embedded in middle of path", () => {
  const vault = makeVault();
  try {
    assert.throws(
      () => resolveVaultPath("notes/../../etc/passwd", vault),
      PathOutsideVaultError,
    );
  } finally { cleanup(vault); }
});

// ── Absolute-path attacks ────────────────────────────────────────────────

test("rejects absolute path outside vault", () => {
  const vault = makeVault();
  try {
    assert.throws(
      () => resolveVaultPath("/etc/passwd", vault),
      PathOutsideVaultError,
    );
  } finally { cleanup(vault); }
});

test("rejects sibling-vault absolute path", () => {
  const vault = makeVault();
  const otherVault = makeVault();
  try {
    fs.writeFileSync(path.join(otherVault, "secret"), "");
    assert.throws(
      () => resolveVaultPath(path.join(otherVault, "secret"), vault),
      PathOutsideVaultError,
    );
  } finally { cleanup(vault); cleanup(otherVault); }
});

// ── Symlink escape attacks ───────────────────────────────────────────────

test("rejects symlink that points outside vault", () => {
  const vault = makeVault();
  const targetDir = makeVault();
  try {
    fs.writeFileSync(path.join(targetDir, "secret"), "leaked");
    fs.symlinkSync(path.join(targetDir, "secret"), path.join(vault, "trap"));
    assert.throws(
      () => resolveVaultPath("trap", vault),
      PathOutsideVaultError,
    );
  } finally { cleanup(vault); cleanup(targetDir); }
});

test("rejects nested symlink directory pointing outside vault", () => {
  const vault = makeVault();
  const targetDir = makeVault();
  try {
    fs.writeFileSync(path.join(targetDir, "a.txt"), "");
    fs.symlinkSync(targetDir, path.join(vault, "external"));
    assert.throws(
      () => resolveVaultPath("external/a.txt", vault),
      PathOutsideVaultError,
    );
  } finally { cleanup(vault); cleanup(targetDir); }
});

test("accepts symlink that stays inside vault", () => {
  const vault = makeVault();
  try {
    fs.mkdirSync(path.join(vault, "wiki"));
    fs.writeFileSync(path.join(vault, "wiki", "real.md"), "");
    fs.symlinkSync(
      path.join(vault, "wiki", "real.md"),
      path.join(vault, "alias.md")
    );
    // Symlink target is inside vault; resolveVaultPath returns the realpath.
    const resolved = resolveVaultPath("alias.md", vault);
    assert.equal(resolved, path.join(vault, "wiki", "real.md"));
  } finally { cleanup(vault); }
});

// ── Input-validation guards ─────────────────────────────────────────────

test("throws TypeError on non-string requested", () => {
  const vault = makeVault();
  try {
    assert.throws(() => resolveVaultPath(null, vault), TypeError);
    assert.throws(() => resolveVaultPath(undefined, vault), TypeError);
    assert.throws(() => resolveVaultPath(42, vault), TypeError);
    assert.throws(() => resolveVaultPath({}, vault), TypeError);
  } finally { cleanup(vault); }
});

test("throws TypeError on missing vaultRoot", () => {
  assert.throws(() => resolveVaultPath("note.md", null), TypeError);
  assert.throws(() => resolveVaultPath("note.md", undefined), TypeError);
  assert.throws(() => resolveVaultPath("note.md", ""), TypeError);
});

test("throws TypeError on empty requested string", () => {
  const vault = makeVault();
  try {
    assert.throws(() => resolveVaultPath("", vault), TypeError);
  } finally { cleanup(vault); }
});

// ── Edge cases ──────────────────────────────────────────────────────────

test("non-existent file inside vault is allowed (callers handle ENOENT)", () => {
  const vault = makeVault();
  try {
    // resolveVaultPath validates the path shape; it does not require the
    // file to exist (Write needs to create new files).
    const resolved = resolveVaultPath("new-file.md", vault);
    assert.equal(resolved, path.join(vault, "new-file.md"));
  } finally { cleanup(vault); }
});

test("path with redundant ./ segments normalizes correctly", () => {
  const vault = makeVault();
  try {
    const resolved = resolveVaultPath("./wiki/./topics/./x.md", vault);
    assert.equal(resolved, path.join(vault, "wiki", "topics", "x.md"));
  } finally { cleanup(vault); }
});

// ── Ancestor-symlink escape (C2 regression) ─────────────────────────────
//
// Before the fix: if `vault/escape` is a symlink to `/tmp/outside/`, then
// `resolveVaultPath("escape/new-file.txt", vault)` passed the check
// because the leaf didn't exist, so the symlink was never dereferenced.
// A subsequent fs.writeFileSync would follow the symlink and write
// outside the vault. The fix walks up to the first existing ancestor,
// realpaths it, then re-checks.

test("rejects write to non-existent leaf under symlinked ancestor", () => {
  const vault = makeVault();
  const outside = makeVault();
  try {
    // vault/escape → outside/
    fs.symlinkSync(outside, path.join(vault, "escape"));
    assert.throws(
      () => resolveVaultPath("escape/pwned.txt", vault),
      PathOutsideVaultError,
    );
  } finally { cleanup(vault); cleanup(outside); }
});

test("rejects deeply-nested non-existent path under symlinked ancestor", () => {
  const vault = makeVault();
  const outside = makeVault();
  try {
    fs.symlinkSync(outside, path.join(vault, "escape"));
    assert.throws(
      () => resolveVaultPath("escape/a/b/c/pwned.txt", vault),
      PathOutsideVaultError,
    );
  } finally { cleanup(vault); cleanup(outside); }
});

test("non-existent nested path under real directory still resolves correctly", () => {
  const vault = makeVault();
  try {
    fs.mkdirSync(path.join(vault, "sub"));
    const resolved = resolveVaultPath("sub/new/deep/file.txt", vault);
    assert.equal(resolved, path.join(vault, "sub", "new", "deep", "file.txt"));
  } finally { cleanup(vault); }
});

test("non-existent file under internal symlink dir stays inside vault", () => {
  const vault = makeVault();
  try {
    // vault/real exists; vault/alias → vault/real
    fs.mkdirSync(path.join(vault, "real"));
    fs.symlinkSync(path.join(vault, "real"), path.join(vault, "alias"));
    const resolved = resolveVaultPath("alias/new-file.txt", vault);
    // Realpath resolves alias → real; composed result is inside vault.
    assert.equal(resolved, path.join(vault, "real", "new-file.txt"));
  } finally { cleanup(vault); }
});

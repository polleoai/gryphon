// R43-6: path checks must hold for another NAME of the same directory/file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { isWithinByIdentity, sameFileAs } = require("../src/path-identity");
const { approvalsStoreVerdict, isApprovalsStorePath } = require("../src/mcp-approvals");
const { validateCliPath } = require("../src/security-settings-store");

const FIRMLINK = "/System/Volumes/Data";
const hasFirmlink = process.platform === "darwin" && fs.existsSync(FIRMLINK);

function withStore(fn: (xdg: string, store: string) => void) {
  const xdg = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-6x-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    fs.mkdirSync(path.join(xdg, "gryphon"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "gryphon", "security-settings.json"), "{}");
    fn(xdg, path.join(xdg, "gryphon"));
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
  }
}

test("R43-6: identity helpers", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-6-"));
  try {
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.symlinkSync(path.join(dir, "a"), path.join(dir, "link"));
    assert.equal(isWithinByIdentity(path.join(dir, "link", "b", "new.txt"), [path.join(dir, "a")]), true);
    assert.equal(isWithinByIdentity(path.join(dir, "elsewhere.txt"), [path.join(dir, "a")]), false);
    fs.writeFileSync(path.join(dir, "f"), "x");
    fs.linkSync(path.join(dir, "f"), path.join(dir, "hard"));
    assert.equal(sameFileAs(path.join(dir, "hard"), [path.join(dir, "f")]), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R43-6: the store guard sees the store through a macOS firmlink", { skip: !hasFirmlink }, () => {
  withStore((_xdg, store) => {
    const aliased = FIRMLINK + path.join(store, "security-settings.json");
    if (!fs.existsSync(aliased)) return; // tmpdir not on the Data volume here
    assert.equal(isApprovalsStorePath(aliased), true);
    assert.ok(approvalsStoreVerdict("write_file", { file_path: aliased }, {}));
  });
});

test("R43-6: a hard link to a store file is the store", () => {
  withStore((xdg, store) => {
    const link = path.join(xdg, "innocent.json");
    fs.linkSync(path.join(store, "security-settings.json"), link);
    assert.equal(isApprovalsStorePath(link), true);
  });
});

test("R43-6: an in-vault binary reached through a symlinked vault folder is refused", { skip: process.platform === "win32" }, () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-6v-"));
  try {
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(path.join(vault, ".bin"), { recursive: true });
    const bin = path.join(vault, ".bin", "codex");
    fs.writeFileSync(bin, "#!/bin/sh\necho hi\n", { mode: 0o755 });
    fs.symlinkSync(vault, path.join(tmp, "VaultLink"));
    // vaultRoot is the realpath (what the scope stores); the path names the link.
    assert.deepEqual(validateCliPath(path.join(tmp, "VaultLink", ".bin", "codex"), vault), { ok: false, reason: "inside-vault" });
    if (hasFirmlink && fs.existsSync(FIRMLINK + bin)) {
      assert.deepEqual(validateCliPath(FIRMLINK + bin, vault), { ok: false, reason: "inside-vault" });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("R43-6: classify sees a protected vault file under another name", { skip: process.platform === "win32" }, () => {
  const { classify } = require("../src/attack-detector");
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-6c-"));
  try {
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(path.join(vault, ".obsidian", "plugins", "gryphon"), { recursive: true });
    fs.symlinkSync(vault, path.join(tmp, "VaultLink"));
    const ctx = { vaultRoot: vault, security: { protectedMode: true, protectedPathsEnabled: true, protectedCommandsEnabled: true } };
    const rel = path.join(".obsidian", "plugins", "gryphon", "data.json");
    assert.equal(classify("Write", { file_path: path.join(tmp, "VaultLink", rel) }, ctx)?.category, "modifies-gryphon");
    if (hasFirmlink && fs.existsSync(FIRMLINK + vault)) {
      assert.equal(classify("Write", { file_path: FIRMLINK + path.join(vault, rel) }, ctx)?.category, "modifies-gryphon");
    }
    assert.equal(classify("Write", { file_path: path.join(tmp, "outside.md") }, ctx), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("R43-20: a rejected CLI path names the product, not the setting key", () => {
  const { CliPathRejectedError } = require("../src/security-settings-store");
  const e = new CliPathRejectedError("codexPath", "/x/codex", "relative");
  assert.match(e.message, /as the Codex location/);
  assert.doesNotMatch(e.message, /codexPath/);
});

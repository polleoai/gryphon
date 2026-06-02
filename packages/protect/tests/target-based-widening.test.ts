/**
 * Regression tests for commit 4: target-based widening + destructive
 * alternatives + quoted-binary fix. Locks the new shapes against future
 * regression and guards against false positives on in-vault uses.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { classify } = require("../src/attack-detector");

const ctx = () => ({
  vaultRoot: "/tmp/vault",
  plugin: {
    settings: {
      protectedCommandsEnabled: true,
      protectedCommandsDisabled: [],
      protectedCommandsCustom: [],
    },
  },
});

const detects = (cmd) => {
  const res = classify("Bash", { command: cmd }, ctx());
  assert.ok(res, `should detect: ${cmd}`);
  return res;
};
const doesNotDetect = (cmd) => {
  const res = classify("Bash", { command: cmd }, ctx());
  assert.equal(res, null, `should NOT detect: ${cmd}`);
};

// ── POSIX writes into sensitive dirs (cp/mv/ln/install) ─────────────

test("cp to /etc/passwd is detected", () => detects("cp /tmp/evil /etc/passwd"));
test("mv to /etc/passwd is detected", () => detects("mv /tmp/evil /etc/passwd"));
test("ln -sf to /etc/passwd is detected", () => detects("ln -sf /tmp/evil /etc/passwd"));
test("install to /etc is detected", () => detects("install -m 644 /tmp/evil /etc/passwd"));
test("cp to ~/.ssh is detected", () => detects("cp /tmp/pubkey ~/.ssh/authorized_keys"));
test("cp to ~/.bashrc is detected", () => detects("cp /tmp/evil ~/.bashrc"));
test("cp to /usr/local is detected", () => detects("cp /tmp/evil /usr/local/bin/foo"));

// In-vault cp/mv/ln must NOT trigger
test("cp within vault does NOT trigger", () =>
  doesNotDetect("cp ./notes/a.md ./archive/a.md"));
test("mv within vault does NOT trigger", () =>
  doesNotDetect("mv ./drafts/x.md ./published/x.md"));
test("ln within vault does NOT trigger", () =>
  doesNotDetect("ln -s ./notes ./shortcut"));

// ── sed -i in sensitive dir ─────────────────────────────────────────

test("sed -i in /etc is detected", () =>
  detects("sed -i 's/root/evil/' /etc/passwd"));
test("sed -i.bak in /etc is detected", () =>
  detects("sed -i.bak 's/x/y/' /etc/hosts"));
test("sed -i in vault does NOT trigger", () =>
  doesNotDetect("sed -i 's/foo/bar/' ./notes/a.md"));

// ── Windows writes into sensitive dirs ──────────────────────────────

test("Copy-Item to Windows\\\\System32 is detected", () =>
  detects("Copy-Item /tmp/evil C:\\\\Windows\\\\System32\\\\foo.dll"));
test("Move-Item to AppData is detected", () =>
  detects("Move-Item /tmp/x C:\\\\Users\\\\me\\\\AppData\\\\foo"));
test("New-Item in ProgramData is detected", () =>
  detects("New-Item -Path C:\\\\ProgramData\\\\evil -ItemType File"));

// ── PowerShell registry widening ────────────────────────────────────

test("Copy-Item into HKLM is detected", () =>
  detects("Copy-Item HKLM:\\\\Software\\\\Run HKCU:\\\\Software\\\\Run"));
test("New-ItemProperty into HKCU is detected", () =>
  detects("New-ItemProperty -Path HKCU:\\\\Run -Name x -Value evil"));
test("New-Item into HKLM is detected", () =>
  detects("New-Item HKLM:\\\\Software\\\\Foo"));

// ── Destructive alternatives ────────────────────────────────────────

test("shred is detected", () => detects("shred -u /tmp/file"));
test("unlink is detected", () => detects("unlink /etc/hosts"));
test("truncate -s 0 is detected", () => detects("truncate -s 0 /etc/passwd"));
test("dd to /dev/sda is detected", () => detects("dd if=/dev/zero of=/dev/sda"));
test("dd to /dev/disk0 is detected", () => detects("dd if=/tmp/foo of=/dev/disk0"));
test("find -delete is detected", () =>
  detects("find /tmp -name '*.log' -delete"));

// dd without /dev target should NOT trigger
test("dd to regular file does NOT trigger", () =>
  doesNotDetect("dd if=/tmp/a of=/tmp/b bs=1M"));

// find without -delete should NOT trigger
test("find without -delete does NOT trigger", () =>
  doesNotDetect("find ./notes -name '*.md'"));

// ── Quoted binary name ──────────────────────────────────────────────

test("'rm' -rf is detected (quoted)", () => detects("'rm' -rf /tmp/foo"));
test("\"rm\" -rf is detected (double-quoted)", () =>
  detects('"rm" -rf /tmp/foo'));
test("bare rm -rf still detected (regression)", () =>
  detects("rm -rf /tmp/foo"));

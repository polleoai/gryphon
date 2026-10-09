// R43-1: hook commands embed a script path under the VAULT folder, whose
// name the vault's author chose. These tests run the real shell.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { shQuote, psQuote, hookCommandLine } = require("../src/shell-quote");
const { buildHookSettings } = require("../src/providers/claude-code/hook-settings-builder");

const posix = process.platform !== "win32";

test("R43-1: shQuote round-trips hostile strings through sh unchanged", { skip: !posix }, () => {
  for (const s of ["a'b", "$(touch x)", "`id`", "$HOME", "a\"b\\c", "Bob's Vault", "x;rm -rf y&|", "O’Brien"]) {
    const out = execFileSync("/bin/sh", ["-c", `printf %s ${shQuote(s)}`], { encoding: "utf8" });
    assert.equal(out, s);
  }
});

test("R43-1: a vault folder named with $( ) or backticks runs nothing", { skip: !posix }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-r43-1-"));
  try {
    const pwned = path.join(tmp, "PWNED");
    const pluginDir = path.join(tmp, `vault$(touch ${pwned})\`touch ${pwned}\``, ".obsidian", "plugins", "gryphon");
    // The real node binary is replaced by printf so the command only echoes
    // its argv — any shell expansion would create PWNED first.
    const settings = buildHookSettings({ pluginDir, socketPath: "/tmp/x.sock", nodePath: "printf" });
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    const out = execFileSync("/bin/sh", ["-c", `${cmd} >/dev/null; printf %s ok`], { encoding: "utf8" });
    assert.equal(out, "ok");
    assert.equal(fs.existsSync(pwned), false, `shell expanded the vault path: ${cmd}`);
    // And the script path reached the program intact.
    const argv = execFileSync("/bin/sh", ["-c", cmd.replace(/^'printf'/, "printf '%s\\n'")], { encoding: "utf8" });
    assert.equal(argv.trim(), path.join(pluginDir, "hooks", "pretool.js"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("R43-1: psQuote doubles ASCII and typographic single quotes", () => {
  assert.equal(psQuote("C:\\Users\\Bob's Vault"), "'C:\\Users\\Bob''s Vault'");
  assert.equal(psQuote("C:\\Users\\O’Brien"), "'C:\\Users\\O’’Brien'");
  assert.equal(psQuote("a‘b‚c‛d"), "'a‘‘b‚‚c‛‛d'");
  assert.equal(hookCommandLine("C:\\node.exe", "C:\\v's\\hooks\\pretool.js", "win32"), "& 'C:\\node.exe' 'C:\\v''s\\hooks\\pretool.js'");
});

test("R43-1: every Windows hook command is a single PowerShell literal per argument", () => {
  const cmd = hookCommandLine("C:\\Program Files\\nodejs\\node.exe", "D:\\Bob's $(Vault)\\hooks\\pretool.js", "win32");
  // Inside '…' PowerShell does no $( ) expansion; the only special char is ', doubled.
  assert.equal(cmd, "& 'C:\\Program Files\\nodejs\\node.exe' 'D:\\Bob''s $(Vault)\\hooks\\pretool.js'");
});

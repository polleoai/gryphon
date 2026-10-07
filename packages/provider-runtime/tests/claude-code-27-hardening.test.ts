/**
 * #27 security-review fixes (fix/issue-27 @ 5d0a444):
 *  1. memory-appendix must never touch a path outside the memory root before
 *     rejecting it — on Windows a realpath/stat of `\\host\share\x` sends the
 *     user's NTLM credentials to `host` (zero-click, from vault CLAUDE.md).
 *  2. memory files have a size ceiling (a vault CLAUDE.md can @-import any
 *     in-root file, e.g. a huge attachment).
 *  3. the liveness probe spawns claude with the scoped flags, in a neutral
 *     cwd — never Obsidian's own cwd (which can be a vault/project dir).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildMemoryAppendix } = require("../src/providers/claude-code/memory-appendix");

function tmpRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-27h-")));
}

/** Record every path handed to realpathSync/statSync while fn runs. */
function recordFsPaths(fn: () => void): string[] {
  const seen: string[] = [];
  const origReal = fs.realpathSync;
  const origStat = fs.statSync;
  fs.realpathSync = function (p: any, ...rest: any[]) { seen.push(String(p)); return origReal.call(this, p, ...rest); };
  fs.statSync = function (p: any, ...rest: any[]) { seen.push(String(p)); return origStat.call(this, p, ...rest); };
  try { fn(); } finally { fs.realpathSync = origReal; fs.statSync = origStat; }
  return seen;
}

test("#27h: network/drive @-imports are rejected with NO fs access to the target", () => {
  const root = tmpRoot();
  const mem = path.join(root, "CLAUDE.md");
  fs.writeFileSync(mem, [
    "Rules here.",
    "@\\\\attacker.example\\share\\x.md",
    "@//attacker.example/share/y.md",
    "@C:\\Windows\\win.ini",
    "@c:/boot.ini",
  ].join("\n"));
  let res: any;
  const touched = recordFsPaths(() => { res = buildMemoryAppendix([mem]); });
  for (const p of touched) {
    assert.ok(!/attacker\.example|win\.ini|boot\.ini/i.test(p), `fs touched a network/drive target: ${p}`);
  }
  assert.match(res.text, /Rules here\./);
  assert.equal(res.missing.length, 0);
  assert.equal(res.warnings.filter((w: string) => /network\/drive paths are never imported/.test(w)).length, 4);
});

test("#27h: an import resolving outside the memory root is skipped before any fs access", () => {
  const parent = tmpRoot();
  const root = path.join(parent, "vault");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(parent, "outside-secret.md"), "SECRET");
  const mem = path.join(root, "CLAUDE.md");
  fs.writeFileSync(mem, "Top.\n@../outside-secret.md\n@/etc/hosts\n");
  let res: any;
  const touched = recordFsPaths(() => { res = buildMemoryAppendix([mem]); });
  assert.ok(!touched.some((p) => p.endsWith("outside-secret.md") || p === "/etc/hosts"),
    `fs touched an out-of-root target: ${touched.join(", ")}`);
  assert.doesNotMatch(res.text, /SECRET/);
  assert.equal(res.warnings.filter((w: string) => /resolves outside/.test(w)).length, 2);
});

test("#27h: in-root imports still work (regression guard)", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "more.md"), "BRAVO-4410");
  const mem = path.join(root, "CLAUDE.md");
  fs.writeFileSync(mem, "ALPHA-7731\n@sub/more.md\n");
  const res = buildMemoryAppendix([mem]);
  assert.match(res.text, /ALPHA-7731/);
  assert.match(res.text, /BRAVO-4410/);
});

test("#27h: an oversized imported file is skipped, not truncated", () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "huge.md"), Buffer.alloc(1024 * 1024 + 1, 0x61));
  const mem = path.join(root, "CLAUDE.md");
  fs.writeFileSync(mem, "Top.\n@huge.md\n");
  const res = buildMemoryAppendix([mem]);
  assert.match(res.text, /Top\./);
  assert.ok(res.text.length < 10000, "huge import must not be inlined");
  assert.ok(res.warnings.some((w: string) => /over the 1048576-byte limit/.test(w)));
});

test("#27h: an oversized top-level memory file is reported missing (rules NOT in effect)", () => {
  const root = tmpRoot();
  const mem = path.join(root, "CLAUDE.md");
  fs.writeFileSync(mem, Buffer.alloc(1024 * 1024 + 1, 0x61));
  const res = buildMemoryAppendix([mem]);
  assert.deepEqual(res.missing, [mem]);
  assert.equal(res.text, "");
});

test("#27h: liveness probe spawns claude scoped, in a neutral cwd", { skip: process.platform === "win32" }, async () => {
  const dir = tmpRoot();
  const log = path.join(dir, "argv.txt");
  const fake = path.join(dir, "claude");
  fs.writeFileSync(fake, [
    "#!/bin/sh",
    `printf '%s\\n' "$PWD" > "${log}"`,
    `for a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done`,
    `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}'`,
    `echo '{"type":"result","subtype":"success","is_error":false,"result":"OK"}'`,
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(fake, 0o755);
  const { testCli } = require("../src/providers/claude-code/test-cli");
  const origCwd = process.cwd();
  process.chdir(dir); // Obsidian's cwd could be a vault; the probe must not inherit it
  try { await testCli(fake); } finally { process.chdir(origCwd); }
  const lines = fs.readFileSync(log, "utf8").split("\n");
  assert.equal(fs.realpathSync(lines[0]), fs.realpathSync(os.tmpdir()), "probe cwd must be the temp dir");
  assert.ok(lines.includes("--setting-sources="), "probe must load no settings files");
  assert.ok(lines.includes("--strict-mcp-config"), "probe must ignore ambient MCP config");
});

// ── Symlink hops (review of 2.10.1): realpathSync follows a link before its
//    target can be checked; on Windows a link to \\host\share leaks NTLM. ──

/** Record every path handed to the fs calls that can reach a link target. */
function recordAllFsPaths(fn: () => void): string[] {
  const seen: string[] = [];
  const names = ["realpathSync", "statSync", "lstatSync", "readFileSync", "readlinkSync", "openSync"];
  const orig: Record<string, any> = {};
  for (const n of names) {
    orig[n] = fs[n];
    fs[n] = function (p: any, ...rest: any[]) { seen.push(String(p)); return orig[n].call(this, p, ...rest); };
  }
  try { fn(); } finally { for (const n of names) fs[n] = orig[n]; }
  return seen;
}

test("#27h: a vault symlinked folder pointing outside is never followed", { skip: process.platform === "win32" }, () => {
  const parent = tmpRoot();
  const outside = path.join(parent, "outside");
  const root = path.join(parent, "vault");
  fs.mkdirSync(outside); fs.mkdirSync(root);
  fs.writeFileSync(path.join(outside, "secret.md"), "SECRET");
  fs.symlinkSync(outside, path.join(root, "sub"));
  const mem = path.join(root, "CLAUDE.md");
  fs.writeFileSync(mem, "Top.\n@sub/secret.md\n");
  let res: any;
  const touched = recordAllFsPaths(() => { res = buildMemoryAppendix([mem]); });
  assert.ok(!touched.some((p) => p.startsWith(outside)), `fs touched outside: ${touched.filter((p) => p.startsWith(outside))}`);
  assert.doesNotMatch(res.text, /SECRET/);
  assert.ok(res.warnings.some((w: string) => /points outside the memory folder/.test(w)));
});

test("#27h: a symlink whose target is a network path is rejected unopened", { skip: process.platform === "win32" }, () => {
  const root = tmpRoot();
  fs.symlinkSync("//attacker.example/share/x.md", path.join(root, "net.md"));
  const mem = path.join(root, "CLAUDE.md");
  fs.writeFileSync(mem, "Top.\n@net.md\n");
  let res: any;
  const touched = recordAllFsPaths(() => { res = buildMemoryAppendix([mem]); });
  assert.ok(!touched.some((p) => /attacker\.example/.test(p)), "network target must never be passed to fs");
  assert.ok(res.warnings.some((w: string) => /symlink to a network location/.test(w)));
});

test("#27h: a top-level CLAUDE.md symlinked outside is not loaded, and not opened", { skip: process.platform === "win32" }, () => {
  const parent = tmpRoot();
  const root = path.join(parent, "vault");
  fs.mkdirSync(root);
  const target = path.join(parent, "elsewhere.md");
  fs.writeFileSync(target, "ELSEWHERE");
  const mem = path.join(root, "CLAUDE.md");
  fs.symlinkSync(target, mem);
  let res: any;
  const touched = recordAllFsPaths(() => { res = buildMemoryAppendix([mem]); });
  assert.ok(!touched.includes(target), "outside target must never be opened");
  assert.deepEqual(res.missing, [mem]);
  assert.doesNotMatch(res.text, /ELSEWHERE/);
});

test("#27h: an in-vault symlink still resolves (regression guard)", { skip: process.platform === "win32" }, () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "real.md"), "CHARLIE-2210");
  fs.symlinkSync("real.md", path.join(root, "alias.md"));
  const mem = path.join(root, "CLAUDE.md");
  fs.writeFileSync(mem, "Top.\n@alias.md\n");
  const res = buildMemoryAppendix([mem]);
  assert.match(res.text, /CHARLIE-2210/);
});

test("#27h: a symlink loop terminates", { skip: process.platform === "win32" }, () => {
  const root = tmpRoot();
  fs.symlinkSync("b.md", path.join(root, "a.md"));
  fs.symlinkSync("a.md", path.join(root, "b.md"));
  const mem = path.join(root, "CLAUDE.md");
  fs.writeFileSync(mem, "Top.\n@a.md\n");
  const res = buildMemoryAppendix([mem]);
  assert.match(res.text, /Top\./);
  assert.ok(res.warnings.some((w: string) => /too many symlinks/.test(w)));
});

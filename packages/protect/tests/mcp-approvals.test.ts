/**
 * Issue #25 (Design rev 2): the vault-MCP approval store.
 *
 * An entry in a vault's `.mcp.json` is a command line. Gryphon only runs one
 * when an approval stored OUTSIDE the vault matches its exact spec. These
 * pin the store: where it lives, how specs hash, and that it fails closed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const approvals = require("../src/mcp-approvals");

function tempDir(prefix = "g25-approvals-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// ── location ───────────────────────────────────────────────────────────

test("store path: $XDG_CONFIG_HOME/gryphon on macOS/Linux, ~/.config fallback", () => {
  assert.equal(
    approvals.approvalsFilePath({ platform: "linux", env: { XDG_CONFIG_HOME: "/x/cfg" }, homedir: "/home/u" }),
    path.join("/x/cfg", "gryphon", "mcp-approvals.json"),
  );
  assert.equal(
    approvals.approvalsFilePath({ platform: "darwin", env: {}, homedir: "/Users/u" }),
    path.join("/Users/u", ".config", "gryphon", "mcp-approvals.json"),
  );
  // A relative XDG_CONFIG_HOME is invalid per the XDG spec — ignore it.
  assert.equal(
    approvals.approvalsFilePath({ platform: "linux", env: { XDG_CONFIG_HOME: "rel/cfg" }, homedir: "/home/u" }),
    path.join("/home/u", ".config", "gryphon", "mcp-approvals.json"),
  );
});

test("store path: %APPDATA%\\gryphon on Windows", () => {
  const p = approvals.approvalsFilePath({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, homedir: "C:\\Users\\u" });
  assert.equal(p, path.win32.join("C:\\Users\\u\\AppData\\Roaming", "gryphon", "mcp-approvals.json"));
});

// ── hashing ────────────────────────────────────────────────────────────

test("hashSpec ignores key order (recursively) and changes on any value change", () => {
  const a = { command: "python3", args: ["-m", "srv"], env: { A: "1", B: "2" } };
  const b = { env: { B: "2", A: "1" }, args: ["-m", "srv"], command: "python3" };
  assert.equal(approvals.hashSpec(a), approvals.hashSpec(b));
  assert.match(approvals.hashSpec(a), /^[0-9a-f]{64}$/);
  for (const changed of [
    { ...a, command: "python" },
    { ...a, args: ["-m", "srv", "--x"] },
    { ...a, args: ["srv", "-m"] },          // array order IS significant
    { ...a, env: { A: "1", B: "3" } },
    { ...a, cwd: "/tmp" },
    { ...a, url: "https://x" },
    { ...a, somethingUnknown: true },       // whole raw entry, not a field allowlist
  ]) {
    assert.notEqual(approvals.hashSpec(changed), approvals.hashSpec(a), JSON.stringify(changed));
  }
});

test("hashSpec hashes ${VAR} references literally (before expansion)", () => {
  const spec = { command: "${HOME}/bin/srv" };
  assert.notEqual(approvals.hashSpec(spec), approvals.hashSpec({ command: `${os.homedir()}/bin/srv` }));
});

// ── persistence ────────────────────────────────────────────────────────

test("approve → isApproved (exact hash only); revoke removes it; file is 0600 in a 0700 dir", () => {
  const dir = tempDir();
  const file = path.join(dir, "gryphon", "mcp-approvals.json");
  const vault = tempDir("g25-vault-");
  const key = approvals.vaultKey(vault);
  const h = approvals.hashSpec({ command: "srv" });

  approvals.approve(key, "srv", h, { file });
  let store = approvals.load(file);
  assert.equal(approvals.isApproved(store, key, "srv", h), true);
  assert.equal(approvals.isApproved(store, key, "srv", approvals.hashSpec({ command: "evil" })), false);
  assert.equal(approvals.isApproved(store, key, "other", h), false);
  assert.equal(approvals.isApproved(store, approvals.vaultKey(tempDir("g25-vault-")), "srv", h), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  // Only the hash is stored — env / headers may hold secrets.
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /"command"/);
  const listed = approvals.listForVault(store, key);
  assert.deepEqual(listed.map((e: any) => e.name), ["srv"]);
  assert.match(listed[0].approvedAt, /^\d{4}-\d{2}-\d{2}T/);

  approvals.revoke(key, "srv", { file });
  store = approvals.load(file);
  assert.equal(approvals.isApproved(store, key, "srv", h), false);
});

test("missing or corrupt store → nothing approved (fail closed)", () => {
  const dir = tempDir();
  assert.deepEqual(approvals.load(path.join(dir, "absent.json")).vaults, {});
  for (const bad of ["{ not json", "[]", "null", '{"version":1,"vaults":[]}', '{"version":1,"vaults":{"/v":{"s":"nothash"}}}']) {
    const f = path.join(dir, "bad.json");
    fs.writeFileSync(f, bad);
    const store = approvals.load(f);
    assert.equal(approvals.isApproved(store, "/v", "s", "nothash"), false, bad);
  }
});

test("vaultKey is the realpath — a symlinked path to the same vault shares approvals", { skip: process.platform === "win32" }, () => {
  const vault = tempDir("g25-vault-");
  const link = path.join(tempDir(), "link");
  fs.symlinkSync(vault, link);
  assert.equal(approvals.vaultKey(link), approvals.vaultKey(vault));
});

test("reader() reads the file fresh on every lookup", () => {
  const file = path.join(tempDir(), "gryphon", "mcp-approvals.json");
  const reader = approvals.reader({ file });
  assert.equal(reader.lookup("/v", "s"), null);
  approvals.approve("/v", "s", "a".repeat(64), { file });
  assert.equal(reader.lookup("/v", "s"), "a".repeat(64));
});

// ── security review of rev 2, finding #4: prototype-named servers ─────

test("#25 review #4: a server named __proto__ can't be approved — a visible error, not a silent no-op", () => {
  const { approve, isApprovableName } = require("../src/mcp-approvals");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g25-proto-"));
  const file = path.join(dir, "gryphon", "mcp-approvals.json");
  assert.equal(isApprovableName("__proto__"), false);
  assert.equal(isApprovableName("kbhost"), true);
  assert.throws(() => approve("/v", "__proto__", "a".repeat(64), { file }), /__proto__/);
});

// ── issue #28 item 3: displaySafe uses Unicode property classes ──

test("#28.3: displaySafe escapes every invisible-padding code point named in the issue", () => {
  const cps = [0x061c, 0x180e, 0x00ad, 0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0xfe00, 0xfe0f, 0xfff9, 0xfffa, 0xfffb, 0x2800,
    0xe0000, 0xe0001, 0xe0041, 0xe007f, 0x202e, 0x2066, 0x200b, 0x2028, 0x2029, 0x0007, 0x009b, 0xfeff];
  for (const cp of cps) {
    const out = approvals.displaySafe(`a${String.fromCodePoint(cp)}b`);
    assert.equal(out, `a\\u{${cp.toString(16).toUpperCase().padStart(4, "0")}}b`, `U+${cp.toString(16)}`);
  }
});

test("#28.3: displaySafe leaves ASCII, CJK and plain emoji unchanged", () => {
  for (const s of ["plain-server_1 (x)", "知识库服务器", "日本語のサーバー", "🚀 rocket 🦄", "Ünïcødé ñ"]) {
    assert.equal(approvals.displaySafe(s), s);
  }
});

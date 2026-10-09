/**
 * Issue #32, the MCP approvals store: an approval lets a vault's MCP server
 * start with no click, so one added outside Gryphon (mid-reply, delayed
 * past it, or while Gryphon was closed) must not count.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const OWN = Symbol.for("gryphon.mcpApprovalsWrites");
const H = (c: string) => c.repeat(64);

function fresh() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32a-")));
  return { dir, file: path.join(dir, "mcp-approvals.json") };
}
function restart() {
  delete (process as any)[OWN];
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}protect${path.sep}src${path.sep}`)) delete require.cache[k];
  return require("../src/mcp-approvals");
}
function plant(file: string, vk: string, name: string, sha: string) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  (j.vaults[vk] = j.vaults[vk] || {})[name] = { sha256: sha, approvedAt: "2026-10-08T00:00:00.000Z" };
  fs.writeFileSync(file, JSON.stringify(j));
}

test("#32: an approval added outside Gryphon is ignored, removed, and reported", () => {
  const m = require("../src/mcp-approvals");
  const { file } = fresh();
  m.approve("/v", "notes", H("a"), { file });
  plant(file, "/v", "evil", H("b"));
  plant(file, "/v", "notes", H("c")); // the approved server's spec swapped
  const seen: any[] = [];
  const off = m.onApprovalsTamper((removed: any[], error: unknown) => seen.push({ removed, error }));
  try {
    const r = m.reader({ file });
    assert.equal(r.lookup("/v", "evil"), null);
    assert.equal(r.lookup("/v", "notes"), null, "a changed hash is not the approval the user gave");
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].removed.map((x: any) => x.name).sort(), ["evil", "notes"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).vaults, {});
  } finally { off(); }
});

test("#32: it is still ignored after a restart; the user's own approvals and removals stand", () => {
  let m = require("../src/mcp-approvals");
  const { file } = fresh();
  m.approve("/v", "notes", H("a"), { file });
  m.approve("/v", "other", H("d"), { file });
  plant(file, "/v", "evil", H("b"));
  m = restart();
  const r = m.reader({ file });
  assert.equal(r.lookup("/v", "evil"), null);
  assert.equal(r.lookup("/v", "notes"), H("a"));
  // An outside REMOVAL only takes protection away from a server: it stands.
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  delete j.vaults["/v"].other;
  fs.writeFileSync(file, JSON.stringify(j));
  assert.equal(r.lookup("/v", "other"), null);
  assert.equal(r.lookup("/v", "notes"), H("a"));
});

test("#32: the planted approval is never used even if the fix can't be saved", () => {
  const m = require("../src/mcp-approvals");
  const { file } = fresh();
  m.approve("/v", "notes", H("a"), { file });
  plant(file, "/v", "evil", H("b"));
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e: any = new Error("EPERM"); e.code = "EPERM"; throw e; };
  const seen: any[] = [];
  const off = m.onApprovalsTamper((removed: any[], error: unknown) => seen.push({ removed, error }));
  try {
    assert.equal(m.reader({ file }).lookup("/v", "evil"), null);
    assert.equal(m.reader({ file }).lookup("/v", "notes"), H("a"));
    assert.equal(seen.length, 1, "reported once, not on every lookup");
    assert.ok(seen[0].error);
  } finally { off(); fs.renameSync = realRename; }
});

test("#32: a first run with no trusted copy adopts the approvals as they are", () => {
  const { file } = fresh();
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { "/v": { notes: { sha256: H("a"), approvedAt: "" } } } }));
  const m = restart();
  assert.equal(m.reader({ file }).lookup("/v", "notes"), H("a"));
  assert.ok(fs.existsSync(path.join(path.dirname(file), ".mcp-approvals.trusted.json")));
});

// Commit security review of 53a8cb6 (same classes, approvals store).
test("#32 review: deleting the approvals' trusted copy mid-session doesn't launder a plant", () => {
  const m = require("../src/mcp-approvals");
  const { file } = fresh();
  m.approve("/v", "notes", H("a"), { file });
  m.reader({ file }).lookup("/v", "notes");
  (process as any)[OWN].raw = null;
  plant(file, "/v", "evil", H("b"));
  fs.rmSync(path.join(path.dirname(file), ".mcp-approvals.trusted.json"));
  assert.equal(m.reader({ file }).lookup("/v", "evil"), null);
});

test("#32 review: approvals judged are the approvals used (no second read)", () => {
  const m = require("../src/mcp-approvals");
  const { file } = fresh();
  m.approve("/v", "notes", H("a"), { file });
  const clean = fs.readFileSync(file, "utf8");
  (process as any)[OWN].raw = null;
  plant(file, "/v", "evil", H("b"));
  const realRead = fs.readFileSync;
  let flipped = false;
  fs.readFileSync = function (p: any, ...rest: any[]) {
    const out = realRead.call(fs, p, ...rest);
    if (!flipped && p === file) { flipped = true; fs.writeFileSync(file, clean); }
    return out;
  };
  try {
    assert.equal(m.reader({ file }).lookup("/v", "evil"), null);
  } finally { fs.readFileSync = realRead; }
});

test("#32 review: with no approvals record at all, the user is told", () => {
  const { file } = fresh();
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { "/v": { notes: { sha256: H("a"), approvedAt: "" } } } }));
  const m = restart();
  const infos: string[] = [];
  const off = m.onApprovalsTamper((_r: any, _e: any, info?: string) => { if (info) infos.push(info); });
  try {
    m.reader({ file }).lookup("/v", "notes");
    assert.deepEqual(infos, ["record-started"]);
  } finally { off(); }
});

test("#32 review F1: writing the approvals AND their copy doesn't approve a server mid-session", () => {
  const m = require("../src/mcp-approvals");
  const { file } = fresh();
  m.approve("/v", "notes", H("a"), { file });
  m.reader({ file }).lookup("/v", "notes");
  (process as any)[OWN].raw = null;
  plant(file, "/v", "evil", H("b"));
  fs.copyFileSync(file, path.join(path.dirname(file), ".mcp-approvals.trusted.json"));
  assert.equal(m.reader({ file }).lookup("/v", "evil"), null);
  assert.equal(m.reader({ file }).lookup("/v", "notes"), H("a"));
});

test("#32 review F1b: a hard-linked approvals copy is not a record after a restart", () => {
  let m = require("../src/mcp-approvals");
  const { file } = fresh();
  m.approve("/v", "notes", H("a"), { file });
  const t = path.join(path.dirname(file), ".mcp-approvals.trusted.json");
  fs.rmSync(t); fs.linkSync(file, t);
  plant(file, "/v", "evil", H("b"));
  m = restart();
  const infos: string[] = [];
  const off = m.onApprovalsTamper((_r: any, _e: any, info?: string) => { if (info) infos.push(info); });
  try {
    m.reader({ file }).lookup("/v", "notes");
    assert.deepEqual(infos, ["record-started"]);
  } finally { off(); }
});

const { processes, APPROVALS_KEYS } = require("./_process-emulation");

test("#32 re-review: an approval made in another vault's window is kept", () => {
  const { file } = fresh();
  const as = processes(APPROVALS_KEYS, "../src/mcp-approvals");
  as("A", (m: any) => { m.approve("/vA", "notes", H("a"), { file }); });
  as("B", (m: any) => { m.approve("/vB", "tools", H("b"), { file }); });
  as("A", (m: any) => { m.approve("/vA", "search", H("c"), { file }); });
  as("B", (m: any) => { assert.equal(m.reader({ file }).lookup("/vB", "tools"), H("b")); });
  as("A", (m: any) => { assert.equal(m.reader({ file }).lookup("/vA", "search"), H("c"), "B didn't remove A's approval"); });
});

test("#32 re-review: Gryphon's own earlier approval bytes can't be replayed after a revoke", () => {
  const m = require("../src/mcp-approvals");
  const { file } = fresh();
  m.approve("/v", "notes", H("a"), { file });
  const withNotes = fs.readFileSync(file, "utf8");
  m.revoke("/v", "notes", { file });
  fs.writeFileSync(file, withNotes);
  assert.equal(m.reader({ file }).lookup("/v", "notes"), null);
});

test("#32 re-review: a \"__proto__\" vault key in either file can't pollute Object.prototype", () => {
  const m = require("../src/mcp-approvals");
  const { file } = fresh();
  m.approve("/v", "notes", H("a"), { file });
  const evil = JSON.stringify({ version: 1, vaults: { ["__proto__"]: { hasOwnProperty: { sha256: H("d"), approvedAt: "x" } } } }).replace('"__proto__"', '"__proto__"');
  fs.writeFileSync(path.join(path.dirname(file), ".mcp-approvals.trusted.json"), evil);
  fs.writeFileSync(file, evil);
  try {
    m.reader({ file }).lookup("/v", "notes");
    m.listForVault(m.load(file), "__proto__");
    assert.equal(typeof Object.prototype.hasOwnProperty, "function");
    assert.equal(({} as any).hasOwnProperty.sha256, undefined);
  } finally {
    if (typeof Object.prototype.hasOwnProperty !== "function") delete (Object.prototype as any).hasOwnProperty;
  }
});

test("#32 QA P2-A: with no approvals record, the notice names the adopted approvals", () => {
  const { file } = fresh();
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { "/v": { notes: { sha256: H("a"), approvedAt: "" } } } }));
  const m = restart();
  const got: any[] = [];
  const off = m.onApprovalsTamper((r: any[], _e: any, info?: string) => { if (info) got.push(r.map((x) => x.name)); });
  try {
    m.reader({ file }).lookup("/v", "notes");
    assert.deepEqual(got, [["notes"]]);
  } finally { off(); }
});

test("#32 post-push F2 (approvals): a user who never approved anything — a delayed approvals file isn't adopted", () => {
  const m = require("../src/mcp-approvals");
  const { file } = fresh();
  assert.equal(m.reader({ file }).lookup("/v", "evil"), null); // no file yet
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { "/v": { evil: { sha256: H("b"), approvedAt: "" } } } }));
  const seen: any[] = [];
  const off = m.onApprovalsTamper((removed: any[], _e: any, info?: string) => seen.push({ removed, info }));
  try {
    assert.equal(m.reader({ file }).lookup("/v", "evil"), null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].info, undefined, "reported as ignored, not adopted");
  } finally { off(); }
});

test("#32 re-review of dcd9fc3: an UNREADABLE approvals file on first run isn't recorded as 'nothing approved'", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const { file } = fresh();
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { "/v": { srv: { sha256: H("a"), approvedAt: "" } } } }));
  const m = restart();
  fs.chmodSync(file, 0o000);
  try { m.reader({ file }).lookup("/v", "srv"); } finally { fs.chmodSync(file, 0o600); }
  assert.equal(m.reader({ file }).lookup("/v", "srv"), H("a"));
});

test("#32 re-review: an approvals file replaced by a directory before a restart doesn't switch the baseline off", { skip: process.platform === "win32" }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g32a-")));
  const file = path.join(dir, "gryphon", "mcp-approvals.json"); // no folder yet
  let m = require("../src/mcp-approvals");
  assert.equal(m.reader({ file }).lookup("/v", "evil"), null);
  assert.ok(fs.existsSync(path.join(path.dirname(file), ".mcp-approvals.trusted.json")), "the record is on disk");
  fs.mkdirSync(file);
  m = restart();
  assert.equal(m.reader({ file }).lookup("/v", "evil"), null);
  fs.rmSync(file, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, vaults: { "/v": { evil: { sha256: H("b"), approvedAt: "" } } } }));
  assert.equal(m.reader({ file }).lookup("/v", "evil"), null);
});

test("#32 review F1: an approvals file kept as a symlink is honoured", { skip: process.platform === "win32" }, () => {
  const { dir, file } = fresh();
  const dot = path.join(dir, "dotfiles-approvals.json");
  fs.writeFileSync(dot, JSON.stringify({ version: 1, vaults: { "/v": { srv: { sha256: H("a"), approvedAt: "" } } } }));
  fs.symlinkSync(dot, file);
  const m = restart();
  assert.equal(m.reader({ file }).lookup("/v", "srv"), H("a"));
});

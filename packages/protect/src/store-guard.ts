// TypeScript module marker.

/**
 * Store-guard script materialization (issue #30, G2).
 *
 * The store-guard hook ships as a string inside @gryphon/protect
 * (generated/store-guard-bundle.ts), so a host that installs only `main.js`
 * still has it. Before each spawn that uses it, it's written to
 *
 *   <approvalsDir>/hooks/store-guard-<sha256[0:16]>.js
 *
 * and verified by content hash. That location is:
 *   - outside every vault: a synced or cloned vault can't ship or swap it;
 *   - per-user on this machine (0700 dir, 0600 file);
 *   - inside the directory the guard itself protects, so once a hook is
 *     live an agent can't rewrite it — and a rewrite that got through
 *     anyway is caught by the hash check before the next spawn.
 * Content-addressed names let two Gryphon versions (an embedder's bundled
 * copy and a standalone install) keep their own scripts side by side.
 */

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const crypto = require("crypto") as typeof import("crypto");
const { approvalsDir } = require("./mcp-approvals");

type Bundle = { source: string; sha256: string };
type Ensured = { ok: true; path: string; sha256: string } | { ok: false; reason: string };

const SCRIPT_RE = /^store-guard-[0-9a-f]{16}\.js$/;
const STALE_MS = 90 * 24 * 60 * 60 * 1000;

function _sha(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function storeGuardDir(): string {
  return path.join(approvalsDir(), "hooks");
}

/** A regular file (not a link) whose content hashes to `sha256`. */
function _verified(file: string, sha256: string): boolean {
  try {
    if (!fs.lstatSync(file).isFile()) return false;
    return _sha(fs.readFileSync(file, "utf8")) === sha256;
  } catch (_) {
    return false;
  }
}

let _swept = false;

/**
 * Best-effort: remove other versions' scripts not touched for 30 days. Runs
 * once per process from ensureStoreGuardScript, so embedders get it too.
 */
// R44 DP-1: an older Gryphon copy (e.g. one built into another plugin)
// never refreshes its script's mtime, so an age-only sweep could delete a
// script a live session of that copy relies on. Only when more than
// MAX_KEPT scripts pile up are the oldest removed — and never one touched
// within STALE_MS. A few versions side by side are therefore never swept.
const MAX_KEPT = 20;

function sweepStoreGuardScripts(keep: string, dir: string = storeGuardDir(), now: number = Date.now()): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  const others: Array<{ p: string; mtime: number }> = [];
  for (const name of names) {
    if (!SCRIPT_RE.test(name) || name === path.basename(keep)) continue;
    const p = path.join(dir, name);
    try { others.push({ p, mtime: fs.statSync(p).mtimeMs }); } catch (_) { /* gone */ }
  }
  if (others.length + 1 <= MAX_KEPT) return;
  others.sort((a, b) => a.mtime - b.mtime);
  for (const { p, mtime } of others.slice(0, others.length + 1 - MAX_KEPT)) {
    if (now - mtime <= STALE_MS) continue;
    try { fs.unlinkSync(p); } catch (e) {
      console.warn(`[gryphon/store-guard] couldn't remove old script ${p}: ${(e as Error).message}`);
    }
  }
}

/**
 * Make sure the current store-guard script is on disk and intact. Rewrites
 * it (atomically: temp file in the same dir, then rename) when it's
 * missing, altered or replaced by a link, and reads it back to verify.
 * Never throws: `{ ok: false, reason }` means the caller runs without the
 * hook and must say so.
 */
function ensureStoreGuardScript(opts: { bundle?: Bundle; dir?: string } = {}): Ensured {
  const bundle: Bundle = opts.bundle || require("./generated/store-guard-bundle");
  if (!bundle || typeof bundle.source !== "string" || !/^[0-9a-f]{64}$/.test(bundle.sha256)) {
    return { ok: false, reason: "the embedded store-guard script is missing" };
  }
  const dir = opts.dir || storeGuardDir();
  const target = path.join(dir, `store-guard-${bundle.sha256.slice(0, 16)}.js`);
  if (!_verified(target, bundle.sha256)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        try { fs.chmodSync(path.dirname(dir), 0o700); fs.chmodSync(dir, 0o700); } catch (_) { /* best effort */ }
      }
      const tmp = path.join(dir, `.store-guard.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      fs.writeFileSync(tmp, bundle.source, { mode: 0o600, flag: "wx" });
      try {
        fs.renameSync(tmp, target);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
        throw e;
      }
    } catch (e) {
      return { ok: false, reason: `couldn't write ${target}: ${(e as Error).message}` };
    }
    if (!_verified(target, bundle.sha256)) {
      return { ok: false, reason: `${target} didn't verify after writing it` };
    }
  }
  // R43-9: mtime means "last used", so another Gryphon copy's 30-day sweep
  // never deletes a script this copy relies on (a missing script makes the
  // CLI treat the hook as a non-blocking failure: the guard is off).
  try { const t = new Date(); fs.utimesSync(target, t, t); } catch (_) { /* best effort */ }
  if (!_swept) {
    _swept = true;
    sweepStoreGuardScripts(target, dir);
  }
  return { ok: true, path: target, sha256: bundle.sha256 };
}

module.exports = {
  ensureStoreGuardScript,
  sweepStoreGuardScripts,
  storeGuardDir,
};

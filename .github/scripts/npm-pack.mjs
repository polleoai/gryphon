#!/usr/bin/env node
// npm-pack.mjs — pack the four @polleoai/gryphon-* packages for the registry.
//
// Shared by the maintainer's release tooling and the Release workflow, so both
// produce the same packages:
//
//   node .github/scripts/npm-pack.mjs --out <dir> [--manifest-out <file>]
//   node .github/scripts/npm-pack.mjs --out <dir> --verify <manifest> --version <v>
//
// Each package is packed (prepack + `files` apply), unpacked into a stage, its
// manifest made publishable — internal file:../<pkg> deps become the sibling's
// exact version, "private" is dropped (the repo manifests keep it so nothing
// publishes from the tree), publishConfig.access is "public" — and re-packed
// into <dir>.
//
// --manifest-out records every file of every package with its sha256.
// --verify recomputes that record for this build and fails unless it is
// identical: the Release workflow stages only packages whose every file
// matches what the maintainer's release tooling built and scanned. Files are
// compared unpacked, so differences in compression can't cause a mismatch.
// dist/ must already be built (npm run build).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKGS = ["protect", "provider-config", "provider-runtime", "plugin"];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    if (!["out", "manifest-out", "verify", "version"].includes(key)) throw new Error(`unknown option --${key}`);
    out[key] = argv[i + 1];
  }
  return out;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fileMap(dir) {
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files[path.relative(dir, p).split(path.sep).join("/")] = sha256(p);
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function makePublishable(manifestFile) {
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
    for (const [dep, spec] of Object.entries(m[field] || {})) {
      if (!dep.startsWith("@polleoai/gryphon-") || !String(spec).startsWith("file:")) continue;
      const sib = path.join(ROOT, "packages", dep.slice("@polleoai/gryphon-".length), "package.json");
      m[field][dep] = JSON.parse(fs.readFileSync(sib, "utf8")).version;
    }
  }
  delete m.private;
  m.publishConfig = { ...(m.publishConfig || {}), access: "public" };
  fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2) + "\n");
  return m;
}

function pack(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-npm-pack-"));
  const record = { packages: {} };
  try {
    for (const p of PKGS) {
      const raw = path.join(stage, "raw", p);
      const unpacked = path.join(stage, "unpacked", p);
      fs.mkdirSync(raw, { recursive: true });
      fs.mkdirSync(unpacked, { recursive: true });
      execFileSync("npm", ["pack", "-w", `@polleoai/gryphon-${p}`, "--pack-destination", raw, "--silent"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
      const [tgz] = fs.readdirSync(raw).filter((f) => f.endsWith(".tgz"));
      execFileSync("tar", ["-xzf", path.join(raw, tgz), "-C", unpacked]);
      const pkgDir = path.join(unpacked, "package");
      const m = makePublishable(path.join(pkgDir, "package.json"));
      // --ignore-scripts: prepack already ran on the real package.
      execFileSync("npm", ["pack", pkgDir, "--ignore-scripts", "--pack-destination", outDir, "--silent"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
      record.packages[m.name] = { version: m.version, files: fileMap(pkgDir) };
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return record;
}

function verify(record, manifestFile, version) {
  const want = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const errs = [];
  const names = (o) => Object.keys(o.packages || {}).sort().join(",");
  if (names(want) !== names(record)) errs.push(`package set differs: built [${names(record)}], manifest [${names(want)}]`);
  for (const [name, got] of Object.entries(record.packages)) {
    const exp = want.packages && want.packages[name];
    if (!exp) continue;
    if (got.version !== version) errs.push(`${name}: built version ${got.version}, release is ${version}`);
    if (exp.version !== version) errs.push(`${name}: manifest version ${exp.version}, release is ${version}`);
    for (const f of new Set([...Object.keys(got.files), ...Object.keys(exp.files)])) {
      if (!(f in exp.files)) errs.push(`${name}: ${f} is in this build but not in the manifest`);
      else if (!(f in got.files)) errs.push(`${name}: ${f} is in the manifest but not in this build`);
      else if (got.files[f] !== exp.files[f]) errs.push(`${name}: ${f} differs from the manifest`);
    }
  }
  return errs;
}

const a = args(process.argv.slice(2));
if (!a.out) throw new Error("--out <dir> is required");
const record = pack(path.resolve(a.out));
if (a["manifest-out"]) fs.writeFileSync(a["manifest-out"], JSON.stringify(record, null, 2) + "\n");
if (a.verify) {
  if (!a.version) throw new Error("--verify needs --version <release version>");
  const errs = verify(record, a.verify, a.version);
  if (errs.length) {
    console.error(`npm-pack: build does NOT match ${a.verify} — refusing to stage:`);
    for (const e of errs.slice(0, 50)) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`npm-pack: all ${Object.keys(record.packages).length} packages match ${a.verify} file for file (${a.version})`);
}

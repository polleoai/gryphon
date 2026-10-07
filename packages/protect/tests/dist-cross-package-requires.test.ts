// gryphon-dev#23 — protect's compiled dist/ must not deep-require
// provider-runtime's TypeScript src/ tree. Pure-dist headless consumers
// (docs/consumer-requirements.md: "import only from packages/*/dist/")
// load these files with plain node, which cannot require a .ts file.
//
// Needs dist/ built for protect + provider-runtime (`npm run prebuild`,
// which scripts/verify-all.sh runs before `npm test`).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PKGS = path.resolve(__dirname, "..", "..");
const PROTECT_DIST = path.join(PKGS, "protect", "dist");
const RUNTIME_DIST = path.join(PKGS, "provider-runtime", "dist");

function listJs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(p));
    else if (ent.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("dist trees are built (run `npm run prebuild` first)", () => {
  assert.ok(fs.existsSync(path.join(PROTECT_DIST, "index.js")), "protect/dist missing");
  assert.ok(fs.existsSync(path.join(RUNTIME_DIST, "index.js")), "provider-runtime/dist missing");
});

test("no protect dist file requires a provider-runtime src/ path", () => {
  const offenders = listJs(PROTECT_DIST).filter((f) =>
    /require\(["'][^"']*provider-runtime\/src\//.test(fs.readFileSync(f, "utf8")),
  );
  assert.deepEqual(offenders.map((f) => path.relative(PKGS, f)), []);
});

test("plain node can load provider-runtime dist and construct every CLI provider", () => {
  // Plain node (no tsx loader) — exactly what a pure-dist consumer runs.
  const script = `
    const rt = require(${JSON.stringify(path.join(PKGS, "provider-runtime"))});
    require(${JSON.stringify(path.join(PKGS, "protect"))});
    for (const kind of ["claude-code", "codex-cli", "gemini-cli", "antigravity-cli"]) {
      // null (binary absent on this machine) is fine; a throw is not.
      rt.createProvider({ settings: { providerPreference: kind } }, "/tmp");
    }
    const { getAdapter, listSupportedKinds } = require(${JSON.stringify(path.join(PROTECT_DIST, "hook-adapters"))});
    for (const k of listSupportedKinds()) getAdapter(k);
    console.log("OK");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.equal(r.status, 0, `child failed:\n${r.stderr}`);
  assert.match(r.stdout, /OK/);
});

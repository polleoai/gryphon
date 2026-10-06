/**
 * A source file must not mix `module.exports = …` with ESM `export` syntax —
 * even a type-only `export type { … }`.
 *
 * tsx / tsc (unit tests, package dist) tolerate the mix, but esbuild treats
 * any `export` as an ES module and drops the `module.exports` assignment, so
 * in the shipped main.js `require()` of that file returns an empty
 * namespace. Issue #25 rev 2 shipped exactly this to the VM E2E: the
 * attack detector's `require("./mcp-approvals")` came back empty, classify()
 * threw on every tool call, and the guardrail denied ordinary writes while
 * never showing the protected-pattern modal. Unit tests were all green.
 *
 * `moduleDetection: "force"` already makes every file a module, so no
 * marker export is needed — keep types as local interfaces.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const PACKAGES = path.resolve(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.ts$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) out.push(p);
  }
  return out;
}

test("no source file mixes module.exports with ESM export syntax (esbuild would drop module.exports)", () => {
  const offenders: string[] = [];
  for (const pkg of fs.readdirSync(PACKAGES)) {
    const src = path.join(PACKAGES, pkg, "src");
    if (!fs.existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const text = fs.readFileSync(file, "utf8");
      if (/^module\.exports\s*=/m.test(text) && /^export\s/m.test(text)) {
        offenders.push(path.relative(PACKAGES, file));
      }
    }
  }
  assert.deepEqual(offenders, [], `mixed CommonJS + ESM exports: ${offenders.join(", ")}`);
});

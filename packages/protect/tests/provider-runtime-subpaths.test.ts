/**
 * protect declares the provider-runtime subpaths it imports in
 * src/provider-runtime-subpaths.d.ts (so it can build before provider-runtime
 * on a fresh checkout). Those declarations must not drift from the real
 * modules: every declared value name has to exist, as the same kind of value.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DTS = fs.readFileSync(path.join(__dirname, "..", "src", "provider-runtime-subpaths.d.ts"), "utf8");

function declaredModules(): Map<string, Array<{ name: string; kind: string }>> {
  const out = new Map();
  for (const m of DTS.matchAll(/declare module "([^"]+)" \{([\s\S]*?)\n\}/g)) {
    const names = [...m[2].matchAll(/^\s*export (function|const) (\w+)/gm)].map((x) => ({ kind: x[1], name: x[2] }));
    out.set(m[1], names);
  }
  return out;
}

test("every provider-runtime subpath protect declares exports what the declaration names", () => {
  const mods = declaredModules();
  assert.ok(mods.size >= 5, `parsed ${mods.size} declared modules`);
  for (const [spec, names] of mods) {
    const real = require(spec);
    for (const { name, kind } of names) {
      assert.ok(name in real, `${spec} has no export ${name}`);
      if (kind === "function") assert.equal(typeof real[name], "function", `${spec}.${name} is not a function`);
      else assert.notEqual(typeof real[name], "function", `${spec}.${name} is a function, declared const`);
    }
  }
});

// packages/provider-runtime/tests/passive-no-protect.test.ts
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Static guard: no file in src/passive/ may import @gryphon/protect (C13/D8).
// The passive session must not load Obsidian's system prompt or permission-IPC.
test("passive subtree does not import @gryphon/protect", () => {
  const dir = path.join(__dirname, "..", "src", "passive");
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.(ts|cjs|js)$/.test(e.name)) {
        if (/@gryphon\/protect/.test(fs.readFileSync(fp, "utf8"))) offenders.push(fp);
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], `protect import(s) found: ${offenders.join(", ")}`);
});

test("createPassiveSession is exported from the package root", () => {
  const rt = require("../src/index");
  assert.equal(typeof rt.createPassiveSession, "function");
});

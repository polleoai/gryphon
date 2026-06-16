#!/usr/bin/env node
// tsc does not emit non-.ts files. The passive MCP shim is a standalone .cjs
// (claude spawns it as `node server.cjs`), so copy it into dist/ after the type
// build. Cross-platform (no shell cp). See src/passive/mcp-shim/server.cjs.
const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "src", "passive", "mcp-shim");
const outDir = path.join(__dirname, "..", "dist", "passive", "mcp-shim");

fs.mkdirSync(outDir, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(srcDir)) {
  if (f.endsWith(".cjs")) {
    fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
    n += 1;
  }
}
console.log(`[copy-passive-shim] copied ${n} shim file(s) to dist/passive/mcp-shim/`);

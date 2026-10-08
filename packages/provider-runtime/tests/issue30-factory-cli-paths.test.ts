/**
 * Issue #30 acceptance A1 (unit): a vault's data.json can no longer choose
 * the binary Gryphon runs. For all four CLI kinds and every factory reader
 * (provider build, detectAvailable, getActiveProviderKind, resolveFallback,
 * explainUnavailable, the factory-without-cliPaths path and the spawn-time
 * `--version` self-heal), a `*Path` pointing at a vault-local script is never
 * executed and never returned; the detected binary is used instead.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: any[]) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const POSIX = process.platform !== "win32";
process.env.XDG_CONFIG_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-f-cfg-")));

const utils = require("../src/utils");
const factory = require("../src/factory");
const { setMachineCliPath } = require("@gryphon/protect");

const FINDERS = ["findClaudeBinary", "findCodexBinary", "findGeminiBinary", "findAntigravityBinary"];
const orig: Record<string, any> = {};
for (const f of FINDERS) orig[f] = utils[f];
function stubDetect(map: Record<string, string | null>) { for (const f of FINDERS) utils[f] = () => (f in map ? map[f] : null); }
function restoreDetect() { for (const f of FINDERS) utils[f] = orig[f]; }

function tmpDir(prefix: string): string { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }
function fakeCli(dir: string, name: string, sentinel?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  const sig = name === "claude" ? " (Claude Code)" : "";
  fs.writeFileSync(p, `#!/bin/sh\n${sentinel ? `touch ${JSON.stringify(sentinel)}\n` : ""}echo "9.9.9${sig}"\n`, { mode: 0o755 });
  return p;
}
function freshEnv<T>(fn: () => T): T {
  const snap = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.GOOGLE_API_KEY;
  try { return fn(); } finally { for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"]) { if (snap[k] !== undefined) process.env[k] = snap[k]; } }
}

const KINDS: Array<[string, string, string, string, string, string]> = [
  // kind, data.json key, finder, binary, provider field, detectAvailable field
  ["claude-code", "claudePath", "findClaudeBinary", "claude", "claudePath", "cliPath"],
  ["codex-cli", "codexPath", "findCodexBinary", "codex", "codexPath", "codexPath"],
  ["gemini-cli", "geminiCliPath", "findGeminiBinary", "gemini", "geminiPath", "geminiCliPath"],
  ["antigravity-cli", "antigravityPath", "findAntigravityBinary", "agy", "antigravityPath", "antigravityPath"],
];

function setup(kind: string, key: string, name: string) {
  const vault = tmpDir("g30-f-vault-");
  const sentinel = path.join(tmpDir("g30-f-s-"), "RAN");
  const evil = fakeCli(path.join(vault, ".tools"), name, sentinel);
  const plugin = {
    app: { vault: { adapter: { getBasePath: () => vault } } },
    securityHostId: "gryphon",
    settings: { providerPreference: kind, fallbackProviderPreference: kind, [key]: evil },
  };
  return { vault, sentinel, evil, plugin };
}

for (const [kind, key, finder, name, field, availField] of KINDS) {
  test(`#30 A1: ${kind} — every factory reader ignores data.json ${key}`, { skip: !POSIX }, () => freshEnv(() => {
    const { vault, sentinel, evil, plugin } = setup(kind, key, name);
    const detected = fakeCli(tmpDir("g30-f-bin-"), name);
    stubDetect({ [finder]: detected });
    try {
      // provider build (both entry points), no cliPaths → factory self-resolves
      const p1: any = factory.createProviderForKind(plugin, kind, vault, {});
      assert.ok(p1, `${kind}: provider built`);
      assert.equal(p1[field], detected);
      const p2: any = factory.createProvider(plugin, vault, {});
      assert.equal(p2[field], detected);
      // detectAvailable
      assert.equal(factory.detectAvailable(plugin)[availField], detected);
      // getActiveProviderKind / resolveFallback
      assert.equal(factory.getActiveProviderKind(plugin), kind);
      assert.equal(factory.resolveFallback(plugin).kind, kind);
      // the spawn-time --version self-heal probes only what the factory handed it
      utils.resolveCliBinary(kind, p1[field]);
      assert.equal(fs.existsSync(sentinel), false, `${kind}: the vault's binary ran`);

      // Nothing detected → the data.json path still isn't used anywhere.
      stubDetect({});
      assert.equal(factory.createProviderForKind(plugin, kind, vault, {}), null);
      assert.equal(factory.detectAvailable(plugin)[availField], null);
      assert.equal(factory.getActiveProviderKind(plugin), null);
      assert.doesNotMatch(factory.explainUnavailable(plugin), new RegExp(evil.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(fs.existsSync(sentinel), false, `${kind}: the vault's binary ran`);
    } finally { restoreDetect(); }
  }));

  test(`#30 A1: ${kind} — an explicit cliPaths map wins; a machine-confirmed path is used`, { skip: !POSIX }, () => freshEnv(() => {
    const { vault, sentinel, plugin } = setup(kind, key, name);
    const confirmed = fakeCli(tmpDir("g30-f-mine-"), name);
    stubDetect({});
    try {
      const p: any = factory.createProviderForKind(plugin, kind, vault, { cliPaths: { [kind]: confirmed } });
      assert.equal(p[field], confirmed);
      setMachineCliPath({ vaultKey: vault, hostId: "gryphon" }, key, confirmed);
      const q: any = factory.createProviderForKind(plugin, kind, vault, {});
      assert.equal(q[field], confirmed);
      assert.equal(factory.getActiveProviderKind(plugin), kind);
      // The view's own host id wins over the plugin's.
      const r: any = factory.createProviderForKind(plugin, kind, vault, { securityHostId: "embedder" });
      assert.equal(r, null, "embedder hasn't confirmed this path and nothing is detected");
      assert.equal(fs.existsSync(sentinel), false);
    } finally { restoreDetect(); }
  }));
}

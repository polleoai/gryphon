// R43-7: degraded protection must be visible and must keep the store guard.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

function sandbox(fn: () => void) {
  const xdg = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-7-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
  }
}

test("R43-7: Protected Mode on, checker down → codex keeps the store guard and the user is told", () => {
  sandbox(() => {
    delete require.cache[require.resolve("../src/hook-dispatcher")];
    const hd = require("../src/hook-dispatcher");
    const notices: string[] = [];
    const r = hd.prepareSpawn({
      kind: "codex-cli",
      plugin: { ipcServer: { isListening: () => false } },
      options: { security: { protectedMode: true }, hostAdapter: { notify: (m: string) => notices.push(m) } },
    });
    try {
      assert.equal(r.ok, true);
      assert.equal(r.mode, "store-guard-fallback");
      assert.match(r.degradationReason, /ipc server not listening/);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /Protected Mode is on, but Gryphon's checks for Codex aren't running/);
      assert.match(fs.readFileSync(r.settingsFile, "utf8"), /store-guard-[0-9a-f]{16}\.js/);
    } finally {
      r.cleanup();
    }
  });
});

test("R43-7: a store guard whose adapter fails is a visible notice", () => {
  sandbox(() => {
    delete require.cache[require.resolve("../src/hook-dispatcher")];
    const hd = require("../src/hook-dispatcher");
    const adapters = require("../src/hook-adapters");
    const real = adapters.getAdapter("gemini-cli");
    const orig = real.buildSpawnExtras;
    real.buildSpawnExtras = () => null;
    const notices: string[] = [];
    try {
      const r = hd.prepareSpawn({
        kind: "gemini-cli",
        plugin: {},
        options: { security: { protectedMode: false }, hostAdapter: { notify: (m: string) => notices.push(m) } },
      });
      assert.equal(r.ok, false);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /can't stop Gemini CLI from changing Gryphon's own security settings/);
    } finally {
      real.buildSpawnExtras = orig;
    }
  });
});

test("R43-7 (CodeRabbit): antigravity gets no store-guard fallback — it refuses instead", () => {
  sandbox(() => {
    delete require.cache[require.resolve("../src/hook-dispatcher")];
    const hd = require("../src/hook-dispatcher");
    const r = hd.prepareSpawn({
      kind: "antigravity-cli",
      plugin: { ipcServer: { isListening: () => false } },
      options: { security: { protectedMode: true } },
    });
    assert.equal(r.ok, false);
    assert.notEqual(r.mode, "store-guard-fallback");
  });
});

test("R44 D1: degraded-protection notices use plain words, not internal reasons", () => {
  sandbox(() => {
    delete require.cache[require.resolve("../src/hook-dispatcher")];
    const hd = require("../src/hook-dispatcher");
    const notices: string[] = [];
    const r = hd.prepareSpawn({
      kind: "codex-cli",
      plugin: { ipcServer: { isListening: () => false } },
      options: { security: { protectedMode: true }, hostAdapter: { notify: (m: string) => notices.push(m) } },
    });
    try {
      assert.equal(notices.length, 1);
      assert.doesNotMatch(notices[0], /ipc|adapter|buildSpawnExtras|pluginDir/i);
      assert.match(notices[0], /approval service isn't running/);
    } finally {
      r.cleanup();
    }
  });
});

test("QA P2-2: missing hook files say reinstall, not restart", () => {
  sandbox(() => {
    delete require.cache[require.resolve("../src/hook-dispatcher")];
    const hd = require("../src/hook-dispatcher");
    const notices: string[] = [];
    const fs2 = require("fs"), os2 = require("os"), path2 = require("path");
    const emptyPluginDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), "p22-"));
    const r = hd.prepareSpawn({
      kind: "codex-cli",
      plugin: { ipcServer: { isListening: () => true, socketPath: () => "/tmp/x.sock" }, absolutePluginDir: () => emptyPluginDir },
      options: { security: { protectedMode: true }, hostAdapter: { notify: (m: string) => notices.push(m) } },
    });
    try {
      assert.equal(notices.length, 1);
      assert.match(notices[0], /Reinstall or update Gryphon/);
    } finally {
      r.cleanup();
      fs2.rmSync(emptyPluginDir, { recursive: true, force: true });
    }
  });
});

test("#35 (QA P3-2): after full protection comes back, a new degradation is reported again", () => {
  sandbox(() => {
    delete require.cache[require.resolve("../src/hook-dispatcher")];
    const hd = require("../src/hook-dispatcher");
    const path2 = require("path");
    const notices: string[] = [];
    const opts = { security: { protectedMode: true }, hostAdapter: { notify: (m: string) => notices.push(m) } };
    const down = { ipcServer: { isListening: () => false } };
    const repoRoot = path2.resolve(__dirname, "..", "..", "..");
    const up = { ipcServer: { isListening: () => true, socketPath: () => "/tmp/x.sock" }, absolutePluginDir: () => repoRoot };
    hd.prepareSpawn({ kind: "codex-cli", plugin: down, options: opts }).cleanup();
    hd.prepareSpawn({ kind: "codex-cli", plugin: down, options: opts }).cleanup();
    assert.equal(notices.length, 1, "deduplicated while still degraded");
    const ok = hd.prepareSpawn({ kind: "codex-cli", plugin: up, options: opts });
    assert.equal(ok.ok, true, ok.degradationReason);
    ok.cleanup();
    hd.prepareSpawn({ kind: "codex-cli", plugin: down, options: opts }).cleanup();
    assert.equal(notices.length, 2, "reported again after recovering");
  });
});

test("#35 sibling (review): after the store guard comes back, losing it again is reported again", () => {
  sandbox(() => {
    delete require.cache[require.resolve("../src/hook-dispatcher")];
    const hd = require("../src/hook-dispatcher");
    const adapter = require("../src/hook-adapters/codex-cli");
    const notices: string[] = [];
    const opts = { security: { protectedMode: false }, hostAdapter: { notify: (m: string) => notices.push(m) } };
    const plugin = { ipcServer: { isListening: () => false } };
    const real = adapter.buildSpawnExtras;
    const broken = () => { throw new Error("hooks file unwritable"); };
    try {
      adapter.buildSpawnExtras = broken;
      hd.prepareSpawn({ kind: "codex-cli", plugin, options: opts }).cleanup();
      hd.prepareSpawn({ kind: "codex-cli", plugin, options: opts }).cleanup();
      assert.equal(notices.length, 1, "deduplicated while still degraded");
      adapter.buildSpawnExtras = real;
      const ok = hd.prepareSpawn({ kind: "codex-cli", plugin, options: opts });
      assert.equal(ok.ok, true, ok.degradationReason);
      assert.equal(ok.mode, "store-guard-only");
      ok.cleanup();
      adapter.buildSpawnExtras = broken;
      hd.prepareSpawn({ kind: "codex-cli", plugin, options: opts }).cleanup();
      assert.equal(notices.length, 2, "reported again after recovering");
    } finally { adapter.buildSpawnExtras = real; }
  });
});

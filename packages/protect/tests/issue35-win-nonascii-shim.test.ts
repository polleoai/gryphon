// Issue #35: cmd.exe reads a .cmd file in the console's OEM code page (437 on
// a US install), not UTF-8. A shim naming `C:\Users\José\…` reached node as
// `Jos├⌐`, node exited 1 ("Cannot find module"), and agy treats a failed hook
// as ALLOW — so a non-ASCII vault or user name silently turned the guard off.
// Reproduced on the Windows VM 2026-10-08. A shim body must be pure ASCII:
// non-ASCII paths go in as their 8.3 short name, or the shim is refused.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const adapter = require("../src/hook-adapters/antigravity-cli");

function withPlatform(value: string, fn: () => any) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try { return fn(); } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

function withWin(fn: (dir: string) => any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue35-"));
  const prev = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = dir;
  try {
    return withPlatform("win32", () => fn(dir));
  } finally {
    if (prev === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const shimBodies = (dir: string) => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith(".cmd")) out.push(fs.readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
};

test("#35: a non-ASCII vault path with no short name refuses the full hook instead of writing a broken shim", () => {
  withWin((dir) => {
    const entry = adapter._buildHookEntry({
      pluginDir: "C:\\Users\\me\\Jos\u00e9's Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      ipcSocketPath: "\\\\.\\pipe\\gryphon",
    });
    assert.equal(entry, null);
    for (const body of shimBodies(dir)) assert.match(body, /^[\x00-\x7f]*$/, "no non-ASCII shim may be written");
  });
});

test("#35: a non-ASCII approvals dir with no short name refuses the store-guard shim", () => {
  withWin(() => {
    const approvalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue35-Jos\u00e9-"));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "issue35-hj-")), "hooks.json");
    try {
      const x = adapter.buildSpawnExtras({
        nodePath: "C:\\node\\node.exe",
        storeGuardOnly: { scriptPath: path.join(approvalsDir, "hooks", "store-guard-0123456789abcdef.js"), approvalsDir },
        _hooksFile: file,
      });
      assert.ok(!x || !x.ok, "must not report an installed guard");
      for (const body of shimBodies(approvalsDir)) assert.match(body, /^[\x00-\x7f]*$/);
    } finally {
      fs.rmSync(approvalsDir, { recursive: true, force: true });
    }
  });
});

test("#35: _asciiForShim keeps ASCII, uses a short name only when it is the same file", () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "issue35a-"));
  try {
    const long = path.join(tmp, "Jos\u00e9", "guard.js");
    fs.mkdirSync(path.dirname(long));
    fs.writeFileSync(long, "x");
    const alias = path.join(tmp, "JOSE~1.JS");
    fs.linkSync(long, alias);
    const other = path.join(tmp, "OTHER~1.JS");
    fs.writeFileSync(other, "x");
    assert.equal(adapter._asciiForShim("C:\\plain\\node.exe", () => null), "C:\\plain\\node.exe");
    assert.equal(adapter._asciiForShim(long, () => alias), alias);
    assert.equal(adapter._asciiForShim(long, () => other), null, "a short name for a different file is refused");
    assert.equal(adapter._asciiForShim(long, () => long), null, "a lookup that echoes the long name back is refused");
    assert.equal(adapter._asciiForShim(long, () => null), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("#35 QA P2-B: the adapter's refusal reason reaches the degradation reason", () => {
  const xdg = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "issue35-x-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  const real = { build: adapter.buildSpawnExtras, last: adapter.lastRefusal };
  try {
    delete require.cache[require.resolve("../src/hook-dispatcher")];
    const hd = require("../src/hook-dispatcher");
    adapter.buildSpawnExtras = () => null;
    adapter.lastRefusal = () => "non-ascii path without a short name";
    const notices: string[] = [];
    const r = hd.prepareSpawn({
      kind: "antigravity-cli",
      plugin: { ipcServer: { isListening: () => false } },
      options: { security: { protectedMode: false }, hostAdapter: { notify: (m: string) => notices.push(m) } },
    });
    try {
      assert.match(String(r.degradationReason), /non-ascii/);
    } finally { r.cleanup && r.cleanup(); }
  } finally {
    adapter.buildSpawnExtras = real.build;
    adapter.lastRefusal = real.last;
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});

test("#35 QA P2-B: a refused non-ASCII launcher is reported with its cause, not as a hooks.json problem", () => {
  withWin(() => {
    adapter.buildSpawnExtras({
      pluginDir: "C:\\Users\\Jos\u00e9\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\node\\node.exe",
      ipcSocketPath: "\\\\.\\pipe\\gryphon",
      _hooksFile: path.join(os.tmpdir(), "issue35-unused-hooks.json"),
    });
    assert.match(String(adapter.lastRefusal()), /non-ascii/);
  });
});

test("#35 QA F3: every Windows launcher refusal records its reason", () => {
  withWin((dir) => {
    adapter.buildSpawnExtras({
      pluginDir: "C:\\Users\\me\\100% Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\node\\node.exe",
      ipcSocketPath: "\\\\.\\pipe\\gryphon",
      _hooksFile: path.join(dir, "hooks.json"),
    });
    assert.match(String(adapter.lastRefusal()), /percent or quote/);
    process.env.LOCALAPPDATA = "C:\\Users\\Jane Smith\\AppData\\Local";
    adapter.buildSpawnExtras({
      pluginDir: "C:\\Users\\me\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\node\\node.exe",
      ipcSocketPath: "\\\\.\\pipe\\gryphon",
      _hooksFile: path.join(dir, "hooks.json"),
    });
    assert.match(String(adapter.lastRefusal()), /no space-free location/);
  });
});

test("#35 QA F1/F4/D: a launcher refusal carries its real cause and fix, with no contradicting notice", () => {
  const xdg = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "issue35-n-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  const real = { build: adapter.buildSpawnExtras, last: adapter.lastRefusal };
  try {
    delete require.cache[require.resolve("../src/hook-dispatcher")];
    const hd = require("../src/hook-dispatcher");
    adapter.buildSpawnExtras = () => null;
    adapter.lastRefusal = () => "non-ascii path without a short name";
    const notices: string[] = [];
    const r = hd.prepareSpawn({
      kind: "antigravity-cli",
      plugin: { ipcServer: { isListening: () => false } },
      options: { security: { protectedMode: false }, hostAdapter: { notify: (m: string) => notices.push(m) } },
    });
    r.cleanup && r.cleanup();
    // Antigravity refuses to start and says why itself (the provider's
    // refusal); a "runs without the guard" notice would contradict it.
    assert.equal(notices.length, 0, JSON.stringify(notices));
    const { launcherRefusalText } = require("../../provider-runtime/dist/launcher-refusal-text");
    const t = launcherRefusalText(r.degradationReason);
    assert.ok(t, String(r.degradationReason));
    assert.match(t.fix, /setshortname/);
    assert.doesNotMatch(t.cause + t.fix, /settings files are valid|hooks\.json/);
  } finally {
    adapter.buildSpawnExtras = real.build;
    adapter.lastRefusal = real.last;
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});

test("#35 review A: a user folder with é (no space) is reported as such, not as a space", () => {
  withWin((dir) => {
    process.env.LOCALAPPDATA = "C:\\Users\\Jos\u00e9\\AppData\\Local";
    adapter.buildSpawnExtras({
      pluginDir: "D:\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\node\\node.exe",
      ipcSocketPath: "\\\\.\\pipe\\gryphon",
      _hooksFile: path.join(dir, "hooks.json"),
    });
    assert.match(String(adapter.lastRefusal()), /non-ascii/);
  });
});

test("#35 re-check F1: a non-ASCII refusal names which folder it is", () => {
  const { launcherRefusalText } = require("../../provider-runtime/src/launcher-refusal-text");
  withWin((dir) => {
    adapter.buildSpawnExtras({
      pluginDir: "D:\\Jos\u00e9 Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\node\\node.exe", ipcSocketPath: "\\\\.\\pipe\\gryphon", _hooksFile: path.join(dir, "h.json"),
    });
    assert.match(launcherRefusalText(adapter.lastRefusal()).cause, /the vault's folder path/);
    adapter.buildSpawnExtras({
      pluginDir: "D:\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\N\u00f6de\\node.exe", ipcSocketPath: "\\\\.\\pipe\\gryphon", _hooksFile: path.join(dir, "h.json"),
    });
    assert.match(launcherRefusalText(adapter.lastRefusal()).cause, /Node\.js is installed/);
    process.env.LOCALAPPDATA = "C:\\Users\\Jos\u00e9\\AppData\\Local";
    adapter.buildSpawnExtras({
      pluginDir: "D:\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\node\\node.exe", ipcSocketPath: "\\\\.\\pipe\\gryphon", _hooksFile: path.join(dir, "h.json"),
    });
    assert.match(launcherRefusalText(adapter.lastRefusal()).cause, /your Windows user folder/);
  });
});

test("#35 re-check: a vault inside a non-ASCII user folder is reported as the user folder", () => {
  const { launcherRefusalText } = require("../../provider-runtime/src/launcher-refusal-text");
  withWin((dir) => {
    const prevApp = process.env.APPDATA;
    process.env.LOCALAPPDATA = "C:\\Users\\Jos\u00e9\\AppData\\Local";
    process.env.APPDATA = "C:\\Users\\Jos\u00e9\\AppData\\Roaming";
    try {
      adapter.buildSpawnExtras({
        pluginDir: "C:\\Users\\Jos\u00e9\\Documents\\Vault\\.obsidian\\plugins\\gryphon",
        nodePath: "C:\\node\\node.exe", ipcSocketPath: "\\\\.\\pipe\\gryphon", _hooksFile: path.join(dir, "h.json"),
      });
      assert.match(String(adapter.lastRefusal()), /: user folder/);
      assert.match(launcherRefusalText(adapter.lastRefusal()).cause, /your Windows user folder/);
    } finally {
      if (prevApp === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevApp;
    }
  });
});

test("#35 re-check J: a non-ASCII roaming folder doesn't block full protection; vault + user folder is named", () => {
  withWin((dir) => {
    const prevApp = process.env.APPDATA;
    process.env.APPDATA = "\\\\srv\\Soci\u00e9t\u00e9\\AppData";
    try {
      const entry = adapter._buildHookEntry({
        pluginDir: "D:\\Vault\\.obsidian\\plugins\\gryphon",
        nodePath: "C:\\node\\node.exe", ipcSocketPath: "\\\\.\\pipe\\gryphon",
      });
      assert.ok(entry, "LOCALAPPDATA is plain: full protection builds");
      adapter.buildSpawnExtras({
        pluginDir: "D:\\\u00dcbersicht\\.obsidian\\plugins\\gryphon",
        nodePath: "C:\\node\\node.exe", ipcSocketPath: "\\\\.\\pipe\\gryphon", _hooksFile: path.join(dir, "h.json"),
      });
      assert.match(String(adapter.lastRefusal()), /: vault and user folder$/);
    } finally {
      if (prevApp === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevApp;
    }
  });
});

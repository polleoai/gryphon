// Antigravity CLI hook adapter — hooks.json shape, global-file merge
// semantics, cleanup, and self-heal.
//
// Antigravity is the ONLY provider whose hook config cannot be isolated to
// a Gryphon-owned temp file: `agy` discovers hooks solely from the
// user-global `~/.gemini/config/hooks.json` (verified live against agy
// v1.1.8 — a workspace `.agents/hooks.json` in the spawn cwd loads 0 hook
// files, with or without a VCS root, and no env var redirects the
// customization root). So this adapter MERGES one named key into a file the
// user also owns, and must never clobber or delete their entries.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const adapter = require("../src/hook-adapters/antigravity-cli");

// Redirect the adapter at a scratch hooks.json so tests never touch the
// real ~/.gemini/config.
function withTempHooksFile(fn: any, seed?: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-agy-hooks-"));
  const file = path.join(dir, "hooks.json");
  if (seed !== undefined) fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (f: any) => JSON.parse(fs.readFileSync(f, "utf8"));

test("kind is 'antigravity-cli'", () => {
  assert.equal(adapter.kind, "antigravity-cli");
});

test("hooks file path resolves under the global Antigravity customization root", () => {
  // Not a temp file: agy only reads this one location.
  assert.equal(adapter.hooksFilePath(), path.join(os.homedir(), ".gemini", "config", "hooks.json"));
});

test("_buildHookEntry registers PreToolUse with a match-all matcher", () => {
  const entry = adapter._buildHookEntry({ pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
  assert.ok(Array.isArray(entry.PreToolUse), "PreToolUse must be present — it is the enforcement gate");
  const group = entry.PreToolUse[0];
  assert.equal(group.matcher, "*", "must gate every tool, not just run_command");
  assert.equal(group.hooks[0].type, "command");
  assert.match(group.hooks[0].command, /pretool/);
});

test("_buildHookEntry sets timeout in SECONDS (Antigravity is seconds, unlike Gemini's ms)", () => {
  // Gemini's adapter multiplies by 1000 because Gemini reads this field as
  // milliseconds; Antigravity's embedded docs say "Execution timeout in
  // seconds. Defaults to 30." Copying Gemini's *1000 here would give a
  // ~3.5-day timeout; copying nothing would give 30s — far below the
  // user's think-time on the approve/deny modal, which is the exact
  // default-allow bug reported against Gemini on 2026-05-03.
  const entry = adapter._buildHookEntry({ pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
  const timeout = entry.PreToolUse[0].hooks[0].timeout;
  assert.equal(typeof timeout, "number");
  assert.ok(timeout >= 120 && timeout <= 600,
    `expected a seconds-scale timeout with room for user think-time, got ${timeout}`);
});

test("the hook command carries Gryphon's env inline, not via spawn inheritance", () => {
  // Verified live: when GRYPHON_HOOK_DIALECT does not reach the hook
  // process, pretool.js emits Claude-shaped output, Antigravity cannot read
  // a decision from it, and it RUNS THE TOOL. The guardrail degrades to
  // silent-allow with no error logged anywhere. Baking the env into the
  // command removes that dependency entirely.
  const entry = adapter._buildHookEntry({
    pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node", ipcSocketPath: "/tmp/gryphon.sock",
  });
  const cmd = entry.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /GRYPHON_HOOK_DIALECT=.?antigravity/,
    "without the dialect the output shape is wrong and agy silently allows");
  assert.match(cmd, /GRYPHON_PERMISSION_SOCKET=.?\/tmp\/gryphon\.sock/);
  assert.match(cmd, /GRYPHON_HOOK_PROVIDER=.?antigravity-cli/);
  assert.ok(cmd.indexOf("pretool") > cmd.indexOf("GRYPHON_HOOK_DIALECT"),
    "assignments must precede the interpreter invocation");
});

test("PostToolUse is NOT registered — Antigravity sends no tool output to frame", () => {
  // Captured live: agy's PostToolUse payload is
  //   { toolCall: null, error: "", stepIdx, conversationId, ... }
  // No tool result, no content. posttool.js exists to wrap tool OUTPUT in
  // untrusted-content framing, so registering it here would install a hook
  // that can never do its job while looking like protection that exists.
  const entry = adapter._buildHookEntry({
    pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node", ipcSocketPath: "/tmp/s.sock",
  });
  assert.equal(entry.PostToolUse, undefined,
    "an inert registered hook is worse than an absent one — it reads as coverage");
});

test("shell metacharacters in a vault path cannot inject into the hook command", () => {
  // Obsidian vault folders are user-named and land in pluginDir verbatim.
  // JSON.stringify yields DOUBLE quotes, and `sh -c` still expands $() and
  // backticks inside those — verified: the substitution executed.
  const entry = adapter._buildHookEntry({
    pluginDir: "/Users/me/My $(touch /tmp/pwned) `id` Vault/.obsidian/plugins/gryphon",
    nodePath: "/usr/bin/node",
    ipcSocketPath: "/tmp/s.sock",
  });
  const cmd = entry.PreToolUse[0].hooks[0].command;
  assert.ok(!/\$\(/.test(cmd.replace(/'\$\('/g, "")) || /'/.test(cmd),
    "command substitution must not survive unquoted");
  // Single-quoted POSIX form: everything between '' is literal.
  assert.match(cmd, /'[^']*\$\(touch \/tmp\/pwned\)[^']*'/,
    "the metacharacters must sit inside single quotes, where sh treats them literally");
});

test("a path containing a single quote is still escaped safely", () => {
  const entry = adapter._buildHookEntry({
    pluginDir: "/Users/me/Bob's Vault/.obsidian/plugins/gryphon",
    nodePath: "/usr/bin/node",
    ipcSocketPath: "/tmp/s.sock",
  });
  const cmd = entry.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /'\\''/, "an embedded ' must be closed, escaped and reopened ('\\'')");
});

// ── Windows command construction ─────────────────────────────────────────
//
// These paths had NEVER executed anywhere before this test existed: the suite
// runs on macOS, so the win32 branch of _makeCommand was unreachable, and no
// Windows VM run had ever exercised the adapter. The cmd branch is the part
// most likely to be wrong — `cmd /c` has no POSIX-style single-quoting, which
// is exactly why the code refuses rather than guesses.
//
// SCOPE LIMIT, stated so these are not over-read: stubbing process.platform
// does NOT switch Node's `path` module, which stays POSIX under a macOS test
// run. So these cover the ENV-QUOTING and REFUSAL logic only — the parts that
// are hand-rolled and can be wrong. Separator construction still comes from
// path.join and is only truly exercised by the windows-vm Argus target.

function withPlatform(value: any, fn: any) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try { return fn(); } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

// Run the win32 branch with the shim directory pointed at a scratch dir, so
// tests never write into the real LOCALAPPDATA/ProgramData.
function withWinShimDir(fn: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-agy-shim-"));
  const prevLocal = process.env.LOCALAPPDATA;
  const prevProgData = process.env.ProgramData;
  process.env.LOCALAPPDATA = dir;
  // Deliberately pointed somewhere INVALID: the shim must never land in a
  // machine-wide directory. See the security note in _winShimPath.
  process.env.ProgramData = "/nonexistent-programdata-must-not-be-used";
  try {
    return withPlatform("win32", () => fn(dir));
  } finally {
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocal;
    if (prevProgData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = prevProgData;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// THE Windows invariant. Everything else in this block is a consequence.
//
// agy executes hook commands through Go's os/exec, which escapes embedded
// double quotes as \" — the C-runtime convention. cmd.exe does not implement
// that convention; it reads \" as a literal quote character, so a quoted
// interpreter path arrives as part of the FILENAME:
//
//   '"C:\Program Files\nodejs\node.exe"' is not recognized as an internal or
//   external command
//
// Captured from agy v1.1.8's own log on a Windows VM, 2026-07-30, where the
// protected write it was meant to block succeeded — agy treats a failed hook
// as ALLOW. The previous version of this test asserted the presence of
// `set "VAR=..."`, pinning the exact form that cannot run, and passed for two
// releases while Windows had no guardrail at all.
//
// A quote cannot be escaped into safety here, so the rule is absolute: no
// double quote may appear anywhere in the command string.
test("win32: the generated command contains NO double quote", () => {
  withWinShimDir(() => {
    const entry = adapter._buildHookEntry({
      pluginDir: "C:\\Users\\me\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      ipcSocketPath: "\\\\.\\pipe\\gryphon",
    });
    assert.ok(entry, "a plain Windows path must produce a command");
    const cmd = entry.PreToolUse[0].hooks[0].command;
    assert.ok(!cmd.includes('"'),
      `Go's exec layer mangles quotes before cmd sees them; command was: ${cmd}`);
    assert.ok(!cmd.includes(" "),
      `a space would force a quote, which is what breaks; command was: ${cmd}`);
    assert.ok(!/'/.test(cmd), "POSIX single quotes are literal characters to cmd");
  });
});

test("win32: the command is a shim file that carries the env and invokes the hook", () => {
  withWinShimDir(() => {
    const nodePath = "C:\\Program Files\\nodejs\\node.exe";
    const entry = adapter._buildHookEntry({
      pluginDir: "C:\\Users\\me\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath,
      ipcSocketPath: "\\\\.\\pipe\\gryphon",
    });
    const shimPath = entry.PreToolUse[0].hooks[0].command;
    assert.ok(fs.existsSync(shimPath), `shim must exist on disk: ${shimPath}`);

    // Quoting inside a .cmd file is safe — nothing re-escapes a file's
    // contents. That is the whole reason the shim exists.
    const body = fs.readFileSync(shimPath, "utf8");
    assert.match(body, /set "GRYPHON_HOOK_DIALECT=antigravity"/);
    assert.match(body, /set "GRYPHON_HOOK_PROVIDER=antigravity-cli"/);
    assert.ok(body.includes('set "GRYPHON_PERMISSION_SOCKET='),
      "the socket must be assigned inside the shim");
    assert.ok(body.includes(`"${nodePath}"`),
      "the interpreter path IS quoted inside the shim, where quoting works");
    assert.ok(body.indexOf("pretool") > body.lastIndexOf('set "'),
      "every assignment must precede the interpreter invocation");
  });
});

test("win32: ownership is still recoverable from a shim-based entry", () => {
  // _socketOf drives the multi-vault guard: vault B's spawn overwrites the
  // shared key, then vault A cleans up and must NOT strip B's guardrail
  // mid-turn. It used to read the socket out of the command string, which a
  // bare shim path no longer contains — so it has to follow the shim.
  withWinShimDir(() => {
    const socket = "\\\\.\\pipe\\gryphon-vault-a";
    const entry = adapter._buildHookEntry({
      pluginDir: "C:\\Users\\me\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      ipcSocketPath: socket,
    });
    assert.equal(adapter._socketOf(entry), socket);
  });
});

test("win32: two sockets get two shims, so concurrent vaults do not collide", () => {
  withWinShimDir(() => {
    const mk = (socket: any) => adapter._buildHookEntry({
      pluginDir: "C:\\Users\\me\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      ipcSocketPath: socket,
    }).PreToolUse[0].hooks[0].command;
    assert.notEqual(mk("\\\\.\\pipe\\a"), mk("\\\\.\\pipe\\b"));
  });
});

test("win32: a value that would break the shim body is REFUSED, not guessed", () => {
  // Inside a .cmd, `%` starts variable expansion and `"` ends a quoted
  // assignment. Windows paths cannot contain `"`, but `%` is legal in a
  // folder name, and a vault is user-named. Declining beats emitting a shim
  // that expands something at hook time.
  withWinShimDir(() => {
    for (const bad of ["C:\\Vault\\a%b\\gryphon", 'C:\\Vault\\a"b\\gryphon']) {
      const entry = adapter._buildHookEntry({
        pluginDir: bad, nodePath: "C:\\node.exe", ipcSocketPath: "\\\\.\\pipe\\g",
      });
      assert.equal(entry, null, `${bad} must not produce a command`);
    }
  });
});

test("win32: refuses when no space-free shim directory is available", () => {
  // The command may not contain a space, so the shim's own path must not
  // either. If both candidate roots are unusable there is no valid command,
  // and degrading is the only honest outcome.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon agy spaced-"));
  const prevLocal = process.env.LOCALAPPDATA;
  const prevProgData = process.env.ProgramData;
  process.env.LOCALAPPDATA = dir;
  process.env.ProgramData = dir;
  try {
    const entry = withPlatform("win32", () => adapter._buildHookEntry({
      pluginDir: "C:\\Users\\me\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      ipcSocketPath: "\\\\.\\pipe\\gryphon",
    }));
    assert.equal(entry, null, "a spaced shim root must not produce a command");
  } finally {
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocal;
    if (prevProgData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = prevProgData;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("win32: _installInto degrades cleanly when the command cannot be built", () => {
  withTempHooksFile((file: any) => {
    const ok = withPlatform("win32", () => adapter._installInto(file, {
      pluginDir: 'C:\\Vault\\a"b\\gryphon', nodePath: "C:\\node.exe", ipcSocketPath: "\\\\.\\pipe\\g",
    }));
    assert.equal(ok, false, "must report failure rather than writing a broken hook");
    assert.equal(fs.existsSync(file), false, "and must not leave a half-written config behind");
  });
});

// ── Merge semantics: the file is shared with the user ────────────────────

test("install() creates the file when absent", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    const json = read(file);
    assert.ok(json[adapter.HOOK_KEY], "gryphon key written");
    assert.ok(json[adapter.HOOK_KEY].PreToolUse);
  });
});

test("install() preserves the user's own hook entries", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    const json = read(file);
    assert.deepEqual(json["user-linter"], { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] },
      "a user's existing named hook must survive untouched");
    assert.ok(json[adapter.HOOK_KEY], "and ours is added alongside");
  }, { "user-linter": { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] } });
});

test("uninstall() removes ONLY the gryphon key, leaving the user's file intact", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    adapter._uninstallFrom(file);
    const json = read(file);
    assert.equal(json[adapter.HOOK_KEY], undefined, "our key is gone");
    assert.ok(json["user-linter"], "the user's key must NOT be collateral damage");
  }, { "user-linter": { PostToolUse: [] } });
});

test("uninstall() removes the file entirely when Gryphon's key was the only content", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    adapter._uninstallFrom(file);
    assert.equal(fs.existsSync(file), false,
      "leaving an empty {} behind would be litter in the user's global config");
  });
});

test("cleanup does NOT remove a key another live Gryphon installed", () => {
  // Two vaults, two Obsidian windows, one shared hooks.json. Vault B's spawn
  // overwrites the key with its own socket; vault A then finishes and cleans
  // up. A blind delete would un-gate vault B mid-turn.
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/p", nodePath: "/n", ipcSocketPath: "/tmp/vaultA.sock" });
    adapter._installInto(file, { pluginDir: "/p", nodePath: "/n", ipcSocketPath: "/tmp/vaultB.sock" });
    adapter._uninstallFrom(file, "/tmp/vaultA.sock");   // A finishes second
    const json = read(file);
    assert.ok(json[adapter.HOOK_KEY],
      "vault B is still running — its guardrail must survive vault A's cleanup");
  });
});

test("cleanup removes the key when it is the one we installed", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/p", nodePath: "/n", ipcSocketPath: "/tmp/mine.sock" });
    adapter._uninstallFrom(file, "/tmp/mine.sock");
    assert.equal(fs.existsSync(file), false);
  });
});

test("a partial write cannot corrupt the user's shared hooks.json", () => {
  // The file is the user's, shared with their own interactive `agy`. A
  // truncated write from a mid-write crash would destroy config we do not
  // own, so the write must land atomically.
  withTempHooksFile((file: any) => {
    const src = fs.readFileSync(require.resolve("../src/hook-adapters/antigravity-cli.ts"), "utf8");
    assert.match(src, /renameSync/,
      "write must go via a temp file + rename, not a direct writeFileSync onto the live path");
  });
});

test("uninstall() on an absent file is a no-op, not a throw", () => {
  withTempHooksFile((file: any) => {
    assert.doesNotThrow(() => adapter._uninstallFrom(file));
  });
});

test("install() is idempotent — a second install does not duplicate handlers", () => {
  withTempHooksFile((file: any) => {
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" });
    const json = read(file);
    assert.equal(json[adapter.HOOK_KEY].PreToolUse.length, 1);
    assert.equal(json[adapter.HOOK_KEY].PreToolUse[0].hooks.length, 1);
  });
});

// ── Self-heal: a crashed Gryphon must not gate the user's own agy ────────

test("self-heal strips a stale gryphon key left behind by a crash", () => {
  withTempHooksFile((file: any) => {
    const stripped = adapter._stripStaleFrom(file);
    assert.equal(stripped, true, "reports that it healed something");
    const json = read(file);
    assert.equal(json[adapter.HOOK_KEY], undefined,
      "a stale key would silently gate the user's own interactive `agy` on every tool call");
    assert.ok(json["user-linter"], "user entries survive the heal");
  }, {
    "user-linter": { PostToolUse: [] },
    [adapter.HOOK_KEY]: { PreToolUse: [{ matcher: "*", hooks: [{ command: "/stale/pretool.js" }] }] },
  });
});

test("self-heal reports false when there is nothing to clean", () => {
  withTempHooksFile((file: any) => {
    assert.equal(adapter._stripStaleFrom(file), false);
  }, { "user-linter": { PostToolUse: [] } });
});

test("a corrupt hooks.json does not throw and does not destroy the user's file", () => {
  withTempHooksFile((file: any) => {
    fs.writeFileSync(file, "{ this is not json");
    // Must fail soft: we cannot safely merge into a file we cannot parse,
    // and silently overwriting it would destroy the user's config.
    assert.doesNotThrow(() => adapter._installInto(file, { pluginDir: "/tmp/plugin", nodePath: "/usr/bin/node" }));
    assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json",
      "the unparseable file is left exactly as found");
  });
});

// ── Spawn extras ─────────────────────────────────────────────────────────

test("buildSpawnExtras sets the antigravity dialect and the IPC socket", () => {
  const extras = adapter.buildSpawnExtras({
    pluginDir: "/tmp/plugin",
    ipcSocketPath: "/tmp/sock",
    nodePath: "/usr/bin/node",
    _hooksFile: withTempHooksFile((f: any) => f),  // path only; file removed
  });
  assert.equal(extras.env.GRYPHON_HOOK_DIALECT, "antigravity",
    "pretool.js needs this to parse camelCase toolCall payloads and emit decision/reason");
  assert.equal(extras.env.GRYPHON_PERMISSION_SOCKET, "/tmp/sock");
  assert.equal(extras.env.GRYPHON_HOOK_PROVIDER, "antigravity-cli");
  assert.equal(typeof extras.cleanup, "function");
  extras.cleanup();
});

test("buildSpawnExtras returns null when a required input is missing", () => {
  assert.equal(adapter.buildSpawnExtras({ pluginDir: "", ipcSocketPath: "/tmp/s", nodePath: "/n" }), null);
  assert.equal(adapter.buildSpawnExtras({ pluginDir: "/p", ipcSocketPath: "", nodePath: "/n" }), null);
  assert.equal(adapter.buildSpawnExtras({ pluginDir: "/p", ipcSocketPath: "/tmp/s", nodePath: "" }), null);
});

test("adapter is registered in the dispatcher registry", () => {
  const { getAdapter, listSupportedKinds } = require("../src/hook-adapters/index");
  assert.ok(getAdapter("antigravity-cli"), "dispatcher must resolve the kind, else prepareSpawn degrades");
  assert.ok(listSupportedKinds().includes("antigravity-cli"));
});

test("win32: the shim is written under LOCALAPPDATA, never a machine-wide dir", () => {
  // The shim is a script agy executes with the user's privileges. A shared
  // location (%ProgramData%) would let any other local account overwrite it
  // and gain code execution as this user on the next tool call -- a local
  // privilege escalation. An earlier revision of _winShimPath had exactly
  // that fallback for profiles whose path contains a space.
  withWinShimDir((dir: any) => {
    const entry = adapter._buildHookEntry({
      pluginDir: "C:\\Users\\me\\Vault\\.obsidian\\plugins\\gryphon",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      ipcSocketPath: "\\\\.\\pipe\\gryphon",
    });
    const shim = entry.PreToolUse[0].hooks[0].command;
    assert.ok(shim.startsWith(dir),
      `shim must live under LOCALAPPDATA (${dir}), got ${shim}`);
    assert.ok(!/programdata/i.test(shim),
      "a machine-wide shim directory is a local privilege-escalation vector");
  });
});

/**
 * Issue #30 acceptance (unit), G2: with Protected Mode off, codex / gemini /
 * antigravity still get a deny-only hook that refuses writes to Gryphon's
 * own trust stores. The hook is one self-contained script, embedded in
 * @gryphon/protect and materialized under the approvals dir — so it needs
 * no IPC server, no plugin dir and no `hooks/` on disk.
 *
 * Items: A8 (rule parity), A10 (embedder-shaped embedder, unit half), A14
 * (script integrity), A15 (bundle drift + self-containment), plus the
 * node-not-found notice from the consumer review.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: any[]) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const POSIX = process.platform !== "win32";

const cfgHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-sg-cfg-")));
process.env.XDG_CONFIG_HOME = cfgHome;
// The antigravity adapter writes ~/.gemini/config/hooks.json — keep it in a sandbox.
const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-sg-home-")));
process.env.HOME = fakeHome;

const protect = require("../src/index");
const mcpApprovals = require("../src/mcp-approvals");
const { classify } = require("../src/attack-detector");
const dispatcher = require("../src/hook-dispatcher");
const storeGuard = require("../src/store-guard");
const bundle = require("../src/generated/store-guard-bundle");
const utils = require("../../provider-runtime/dist/utils");

const DIR = mcpApprovals.approvalsDir();
const STORE_FILE = path.join(DIR, "security-settings.json");
const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-sg-vault-")));

/** The Embedder shape: a community-directory install — main.js only. */
function embedderStub() {
  return {
    app: { vault: { adapter: { getBasePath: () => vault } } },
    settings: { protectedMode: false },
    // NO ipcServer, NO absolutePluginDir, NO hooks/ on disk.
  };
}
const OFF = Object.freeze({ protectedMode: false, permissionMode: "bypassPermissions" });

// ── A8 fixture table ───────────────────────────────────────────────────

const FIXTURES: Array<{ name: string; tool: string; input: any; deny?: boolean }> = [
  { name: "shell redirect", tool: "Bash", input: { command: `echo '{}' > ~/.config/gryphon/security-settings.json` }, deny: true },
  { name: "shell tee literal dir", tool: "Bash", input: { command: `echo x | tee ${DIR}/mcp-approvals.json` }, deny: true },
  { name: "shell cp", tool: "Bash", input: { command: `cp /tmp/x ${DIR}/security-settings.json` }, deny: true },
  { name: "shell mv into XDG", tool: "Bash", input: { command: `mv /tmp/x "$XDG_CONFIG_HOME/gryphon/security-settings.json"` }, deny: true },
  { name: "python -c", tool: "Bash", input: { command: `python3 -c "open('${DIR}/security-settings.json','w').write('{}')"` }, deny: true },
  { name: "powershell appdata", tool: "PowerShell", input: { command: `Set-Content $env:APPDATA\\gryphon\\security-settings.json '{}'` }, deny: true },
  { name: "gemini shell", tool: "run_shell_command", input: { command: "rm ~/.config/gryphon/mcp-approvals.json" }, deny: true },
  { name: "unrelated shell", tool: "Bash", input: { command: "echo hi > notes/a.md" }, deny: false },
  { name: "file write abs", tool: "Write", input: { file_path: STORE_FILE }, deny: true },
  { name: "gemini write_file", tool: "write_file", input: { file_path: path.join(DIR, "x.json") }, deny: true },
  { name: "relative with cwd", tool: "Edit", input: { file_path: path.relative(vault, STORE_FILE) }, deny: true },
  { name: "store-guard script itself", tool: "Write", input: { file_path: path.join(DIR, "hooks", "store-guard-0000.js") }, deny: true },
  { name: "unknown mcp tool", tool: "mcp__fs__save", input: { path: STORE_FILE, content: "{}" }, deny: true },
  { name: "unrelated in-vault write", tool: "Write", input: { file_path: path.join(vault, "notes", "a.md") }, deny: false },
  { name: "read is never gated", tool: "Read", input: { file_path: STORE_FILE }, deny: false },
  { name: "windows-style path in a file tool", tool: "Write", input: { file_path: "C:\\Users\\u\\AppData\\Roaming\\gryphon\\security-settings.json" } },
];

function hookVerdict(scriptPath: string, dialect: string, payload: any, extraEnv: Record<string, string> = {}): string {
  const args = [scriptPath, dialect, DIR];
  const r = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "g30-sg-cwd-")),
    env: { PATH: process.env.PATH || "", HOME: fakeHome, XDG_CONFIG_HOME: cfgHome, ...extraEnv },
    timeout: 20000,
  });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  if (dialect === "gemini" || dialect === "antigravity") return out.decision;
  return out.hookSpecificOutput.permissionDecision;
}

function materialized(): string {
  const r = protect.ensureStoreGuardScript();
  assert.equal(r.ok, true, `ensureStoreGuardScript failed: ${r.reason}`);
  return r.path;
}

test("#30: @gryphon/protect exports the store-guard API", () => {
  for (const k of ["approvalsStoreVerdict", "ensureStoreGuardScript"]) assert.ok(protect[k], `missing export ${k}`);
});

test("#30 A8: approvalsStoreVerdict, classify and the bundled hook agree on every fixture", () => {
  const script = materialized();
  for (const f of FIXTURES) {
    const v = mcpApprovals.approvalsStoreVerdict(f.tool, f.input, { cwd: vault });
    const c = classify(f.tool, f.input, { vaultRoot: vault, security: { protectedMode: true } });
    const classifyDeny = !!c && c.matchedPattern === "gryphon MCP approval store";
    assert.equal(!!v, classifyDeny, `${f.name}: verdict vs classify`);
    if (f.deny !== undefined) assert.equal(!!v, f.deny, `${f.name}: expected deny=${f.deny}`);
    const hook = hookVerdict(script, "claude", { tool_name: f.tool, tool_input: f.input, cwd: vault });
    assert.equal(hook === "deny", !!v, `${f.name}: hook vs verdict (hook said ${hook})`);
  }
});

test("#30 A8: the hook speaks every dialect", () => {
  const script = materialized();
  const deny = { tool_name: "Bash", tool_input: { command: `rm ${STORE_FILE}` }, cwd: vault };
  const allow = { tool_name: "Bash", tool_input: { command: "ls" }, cwd: vault };
  assert.equal(hookVerdict(script, "codex", deny), "deny");
  assert.equal(hookVerdict(script, "codex", allow), "allow");
  assert.equal(hookVerdict(script, "gemini", { ...deny, tool_name: "run_shell_command" }), "deny");
  assert.equal(hookVerdict(script, "gemini", { ...allow, tool_name: "run_shell_command" }), "allow");
  const agy = (args: any, name = "run_command") => ({ toolCall: { name, args }, workspacePaths: [vault] });
  assert.equal(hookVerdict(script, "antigravity", agy({ CommandLine: `rm ${STORE_FILE}` })), "deny");
  assert.equal(hookVerdict(script, "antigravity", agy({ TargetFile: STORE_FILE, CodeContent: "{}" }, "write_to_file")), "deny");
  assert.equal(hookVerdict(script, "antigravity", agy({ CommandLine: "ls" })), "allow");
});

test("#30: a tampered XDG_CONFIG_HOME in the agent's env can't move the guarded dir", () => {
  const script = materialized();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "g30-sg-elsewhere-"));
  const payload = { tool_name: "Write", tool_input: { file_path: STORE_FILE }, cwd: vault };
  assert.equal(hookVerdict(script, "claude", payload, { XDG_CONFIG_HOME: elsewhere }), "deny");
});

test("#30: the hook fails closed on a crash-shaped payload for antigravity", () => {
  const script = materialized();
  assert.equal(hookVerdict(script, "antigravity", { nonsense: true }), "deny");
});

// ── A15: bundle drift + self-containment ───────────────────────────────

test("#30 A15: the committed bundle equals a fresh esbuild bundle of store-guard.ts", () => {
  const { bundleStoreGuard } = require("../scripts/build-store-guard");
  const fresh = bundleStoreGuard();
  assert.equal(fresh, bundle.source, "run: npm run gen:store-guard -w @gryphon/protect");
  const sha = require("crypto").createHash("sha256").update(bundle.source).digest("hex");
  assert.equal(bundle.sha256, sha);
});

test("#30 A15: the materialized script has no relative requires and runs from an empty cwd", () => {
  assert.equal(/require\(\s*["']\.\.?\//.test(bundle.source), false, "relative require in the bundle");
  const script = materialized();
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "g30-sg-iso-")), "guard.js");
  fs.copyFileSync(script, copy);
  for (const f of FIXTURES.filter((x) => x.deny !== undefined)) {
    const hook = hookVerdict(copy, "claude", { tool_name: f.tool, tool_input: f.input, cwd: vault }, { NODE_PATH: "" });
    assert.equal(hook === "deny", f.deny, `${f.name}`);
  }
});

// ── A14: script integrity ──────────────────────────────────────────────

test("#30 A14a: a tampered script is rewritten before the next spawn", () => {
  const p = materialized();
  assert.ok(p.startsWith(path.join(DIR, "hooks") + path.sep));
  assert.equal(path.basename(p), `store-guard-${bundle.sha256.slice(0, 16)}.js`);
  fs.writeFileSync(p, "process.stdout.write('{}')\n");
  const again = materialized();
  assert.equal(again, p);
  assert.equal(fs.readFileSync(p, "utf8"), bundle.source);
});

test("#30 A14c: two embedded hashes coexist without rewriting each other", () => {
  const mine = materialized();
  const otherSource = "// other version\n" + bundle.source;
  const other = { source: otherSource, sha256: require("crypto").createHash("sha256").update(otherSource).digest("hex") };
  const r = protect.ensureStoreGuardScript({ bundle: other });
  assert.equal(r.ok, true);
  assert.notEqual(r.path, mine);
  assert.equal(fs.readFileSync(mine, "utf8"), bundle.source);
  assert.equal(fs.readFileSync(r.path, "utf8"), other.source);
  materialized();
  assert.equal(fs.readFileSync(r.path, "utf8"), other.source, "mine didn't clobber the other version's file");
});

test("#30 A14b: an unwritable approvals dir → preflight ok:false, a one-time notice, no throw", { skip: !POSIX || process.getuid?.() === 0 }, () => {
  const ro = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g30-sg-ro-")));
  const saved = process.env.XDG_CONFIG_HOME;
  fs.mkdirSync(path.join(ro, "gryphon"), { mode: 0o500 });
  process.env.XDG_CONFIG_HOME = ro;
  const notes: string[] = [];
  const hostAdapter = { notify: (m: string) => { notes.push(m); } };
  try {
    const r = protect.ensureStoreGuardScript();
    assert.equal(r.ok, false);
    for (let i = 0; i < 2; i++) {
      const s = dispatcher.prepareSpawn({ kind: "codex-cli", plugin: embedderStub(), options: { security: OFF, hostAdapter } });
      assert.equal(s.ok, false);
      assert.match(s.degradationReason, /store-guard script unavailable/);
    }
    assert.equal(notes.length, 1, "notice shown once");
    assert.match(notes[0], /settings folder/i);
  } finally {
    process.env.XDG_CONFIG_HOME = saved;
    fs.chmodSync(path.join(ro, "gryphon"), 0o700);
  }
});

test("#30 (consumer note 1): no node binary → the same one-time visible notice, reason named", () => {
  const orig = utils.findNodeBinary;
  utils.findNodeBinary = () => null;
  const notes: string[] = [];
  const hostAdapter = { notify: (m: string) => { notes.push(m); } };
  try {
    for (const kind of ["gemini-cli", "gemini-cli"]) {
      const s = dispatcher.prepareSpawn({ kind, plugin: embedderStub(), options: { security: OFF, hostAdapter } });
      assert.equal(s.ok, false);
      assert.match(s.degradationReason, /no node binary/);
    }
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Node\.js/);
  } finally { utils.findNodeBinary = orig; }
});

// ── A10: embedder-shaped embedder (unit) ─────────────────────────────────

test("#30 A10: preflight returns store-guard-only with no ipcServer, no plugin dir, no hooks/", () => {
  const pf = dispatcher._preflight(embedderStub(), OFF);
  assert.equal(pf.ok, true, `preflight: ${pf.reason}`);
  assert.equal(pf.mode, "store-guard-only");
  assert.ok(pf.storeGuardScript && fs.existsSync(pf.storeGuardScript));
  // Protected Mode on keeps today's full-mode requirements.
  const on = dispatcher._preflight(embedderStub(), { protectedMode: true });
  assert.equal(on.ok, false);
  assert.equal(on.mode, "full");
});

test("#30 A10: claude-code with Protected Mode off keeps its deny-glob path", () => {
  const s = dispatcher.prepareSpawn({ kind: "claude-code", plugin: embedderStub(), options: { security: OFF } });
  assert.equal(s.ok, false);
  assert.match(s.degradationReason, /protectedMode is off/);
});

/** Pull the hook command each CLI would run, from the config the adapter wrote. */
function hookCommandFor(kind: string, extras: any): string {
  if (kind === "codex-cli") {
    const toml = fs.readFileSync(path.join(extras.env.CODEX_HOME, "config.toml"), "utf8");
    const blocks = toml.match(/\[\[hooks\.(\w+)\]\]/g) || [];
    assert.deepEqual([...new Set(blocks)], ["[[hooks.PreToolUse]]"], "codex: only PreToolUse");
    return JSON.parse(toml.match(/^command = (.*)$/m)![1]);
  }
  if (kind === "gemini-cli") {
    const json = JSON.parse(fs.readFileSync(extras.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8"));
    assert.deepEqual(Object.keys(json.hooks), ["BeforeTool"], "gemini: only BeforeTool");
    return json.hooks.BeforeTool[0].hooks[0].command;
  }
  const json = JSON.parse(fs.readFileSync(path.join(fakeHome, ".gemini", "config", "hooks.json"), "utf8"));
  const entry = json["gryphon-store-guard"];
  assert.deepEqual(Object.keys(entry), ["PreToolUse"], "agy: only PreToolUse");
  return entry.PreToolUse[0].hooks[0].command;
}

for (const [kind, toolName, payloadOf] of [
  ["codex-cli", "Bash", (cmd: string) => ({ tool_name: "Bash", tool_input: { command: cmd }, cwd: vault })],
  ["gemini-cli", "run_shell_command", (cmd: string) => ({ tool_name: "run_shell_command", tool_input: { command: cmd }, cwd: vault })],
  ["antigravity-cli", "run_command", (cmd: string) => ({ toolCall: { name: "run_command", args: { CommandLine: cmd } }, workspacePaths: [vault] })],
] as Array<[string, string, (cmd: string) => any]>) {
  test(`#30 A10: ${kind} — the configured hook is the materialized store-guard and denies the store write`, { skip: !POSIX }, () => {
    const extras = dispatcher.prepareSpawn({ kind, plugin: embedderStub(), options: { security: OFF } });
    try {
      assert.equal(extras.ok, true, `${kind}: ${extras.degradationReason}`);
      assert.equal(extras.mode, "store-guard-only");
      const command = hookCommandFor(kind, extras);
      const script = materialized();
      assert.ok(command.includes(script), `${kind}: hook command must point at ${script}, got ${command}`);
      assert.ok(!/GRYPHON_PERMISSION_SOCKET/.test(command), "no IPC in this mode");
      // Run the command exactly as the CLI's shell would, with an EMPTY
      // inherited env apart from PATH/HOME: the dialect must survive.
      const run = (payload: any) => {
        const r = spawnSync("/bin/sh", ["-c", command], {
          input: JSON.stringify(payload), encoding: "utf8",
          env: { PATH: process.env.PATH || "", HOME: fakeHome }, timeout: 20000,
        });
        assert.equal(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        return out.decision || out.hookSpecificOutput.permissionDecision;
      };
      assert.equal(run(payloadOf(`echo '{}' > ${STORE_FILE}`)), "deny", `${kind}: shell write`);
      assert.equal(run(payloadOf(`echo hi > ${path.join(vault, "note.md")}`)), "allow", `${kind}: unrelated write`);
      void toolName;
    } finally { extras.cleanup(); }
  });
}

test("#30 (security review): an agy store-guard install never displaces another window's full-mode key", { skip: !POSIX }, () => {
  const { _installInto, HOOK_KEY, STORE_GUARD_HOOK_KEY, buildSpawnExtras } = require("../src/hook-adapters/antigravity-cli");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "g30-agy-")), "hooks.json");
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "g30-agy-plugin-"));
  assert.ok(_installInto(file, { pluginDir, nodePath: process.execPath, ipcSocketPath: "/tmp/window-a.sock" }));
  const fullBefore = JSON.parse(fs.readFileSync(file, "utf8"))[HOOK_KEY];
  const x = buildSpawnExtras({ nodePath: process.execPath, storeGuardOnly: { scriptPath: materialized(), approvalsDir: DIR }, _hooksFile: file });
  assert.ok(x);
  let json = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(json[HOOK_KEY], fullBefore, "window A's full-mode key is untouched");
  assert.ok(json[STORE_GUARD_HOOK_KEY], "the store guard sits under its own key");
  x.cleanup();
  json = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(json[HOOK_KEY], fullBefore, "cleanup leaves window A's key alone");
  assert.equal(json[STORE_GUARD_HOOK_KEY], undefined);
});

test("R43-9: a verified script's mtime is refreshed, so another copy's sweep keeps it", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { ensureStoreGuardScript, sweepStoreGuardScripts } = require("../src/store-guard");
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-9-"));
  try {
    const a = ensureStoreGuardScript({ dir });
    assert.equal(a.ok, true);
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    fs.utimesSync(a.path, old, old);
    // This copy uses it again (verified, not rewritten)…
    assert.equal(ensureStoreGuardScript({ dir }).ok, true);
    // …then another version's sweep runs: the script must survive.
    sweepStoreGuardScripts(path.join(dir, "store-guard-ffffffffffffffff.js"), dir);
    assert.equal(fs.existsSync(a.path), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Issue #25 (Design rev 2) acceptance #2: the chat can't approve its own MCP
 * servers. Any Write / Edit / shell command aimed at Gryphon's approval store
 * classifies as protected — so gate() always asks the user (even in YOLO) and
 * auto-deny denies it — and the no-hooks fallback deny-list covers it too.
 *
 * The store lives outside the vault, so this can't be a vault-relative
 * DEFAULT_PROTECTED_PATHS entry; it's a fixed check that no per-pattern or
 * master toggle switches off.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const { classify } = require("../src/attack-detector");
const { buildDisallowedTools } = require("../src/cc-disallow-translator");
const { approvalsFilePath } = require("../src/mcp-approvals");

const STORE = approvalsFilePath();
const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g25-guard-")));

const allOff = {
  protectedPathsEnabled: false,
  protectedCommandsEnabled: false,
};
const ctx = (settings: Record<string, unknown> = {}) => ({ vaultRoot: vault, plugin: { settings } });

for (const [label, settings] of [["defaults", {}], ["every protected list switched off", allOff]] as const) {
  test(`#25 guard (${label}): Write / Edit to the approval store is protected`, () => {
    for (const [tool, input] of [
      ["Write", { file_path: STORE, content: "{}" }],
      ["Edit", { file_path: STORE, old_string: "a", new_string: "b" }],
      ["write_file", { file_path: STORE, content: "{}" }],
      // Atomic-rename temp files land in the same dir — the whole dir is ours.
      ["Write", { file_path: path.join(path.dirname(STORE), "x.tmp"), content: "{}" }],
      // Case variation resolves to the same file on macOS / Windows.
      ["Write", { file_path: STORE.toUpperCase(), content: "{}" }],
    ] as const) {
      const r = classify(tool, input, ctx(settings));
      assert.ok(r, `${tool} ${input.file_path} should be protected`);
      assert.equal(r.category, "modifies-gryphon");
    }
  });

  test(`#25 guard (${label}): shell commands that touch the approval store are protected`, () => {
    for (const [tool, command] of [
      ["Bash", `echo '{"version":1}' > ${STORE}`],
      ["Bash", `cd ~/.config/gryphon && cp /tmp/x ./m.json`],
      ["Bash", `python3 -c "open('mcp-approvals.json','w')"`],
      ["Bash", `cat > "$XDG_CONFIG_HOME/gryphon/a" <<EOF`],
      ["PowerShell", `Set-Content "$env:APPDATA\\gryphon\\mcp-approvals.json" '{}'`],
      ["PowerShell", `Copy-Item x C:\\Users\\u\\AppData\\Roaming\\gryphon\\y`],
    ] as const) {
      const r = classify(tool, { command }, ctx(settings));
      assert.ok(r, `${command} should be protected`);
      assert.equal(r.category, "modifies-gryphon");
    }
  });
}

test("#25 guard: ordinary vault and out-of-vault writes are unaffected", () => {
  assert.equal(classify("Write", { file_path: "notes/a.md", content: "x" }, ctx()), null);
  assert.equal(classify("Write", { file_path: path.join(os.tmpdir(), "elsewhere.json"), content: "x" }, ctx()), null);
  assert.equal(classify("Bash", { command: "ls ~/.config" }, ctx()), null);
});

test("#25 guard: the no-hooks fallback deny-list covers the approval store", () => {
  for (const settings of [{}, allOff]) {
    const globs = buildDisallowedTools(settings);
    assert.ok(globs.includes("Bash(*mcp-approvals*)"), JSON.stringify(globs));
    assert.ok(globs.some((g: string) => g.startsWith("Write(") && g.includes("gryphon")), "Write glob for the store dir");
    assert.ok(globs.some((g: string) => g.startsWith("Edit(") && g.includes("gryphon")), "Edit glob for the store dir");
  }
});

// ── security review of rev 2, finding #1: every file-mutating tool ────

for (const [label, settings] of [["defaults", {}], ["every protected list switched off", allOff]] as const) {
  test(`#25 review #1 (${label}): MultiEdit / NotebookEdit to the approval store are protected`, () => {
    for (const [tool, input] of [
      ["MultiEdit", { file_path: STORE, edits: [{ old_string: "a", new_string: "b" }] }],
      ["NotebookEdit", { notebook_path: STORE, new_source: "x" }],
      ["NotebookEdit", { notebook_path: path.join(path.dirname(STORE), "n.ipynb"), new_source: "x" }],
    ] as const) {
      const r = classify(tool, input, ctx(settings));
      assert.ok(r, `${tool} ${JSON.stringify(input)} should be protected`);
      assert.equal(r.category, "modifies-gryphon");
    }
  });

  test(`#25 review #1 (${label}): ANY tool whose path argument resolves into the store is protected`, () => {
    for (const [tool, input] of [
      ["SomeFutureTool", { path: STORE }],
      ["SomeFutureTool", { target_path: path.join(path.dirname(STORE), "x") }],
      ["SomeFutureTool", { destination: STORE }],
    ] as const) {
      const r = classify(tool, input, ctx(settings));
      assert.ok(r, `${tool} ${JSON.stringify(input)} should be protected`);
      assert.equal(r.category, "modifies-gryphon");
    }
  });
}

test("#25 review #1: MultiEdit / NotebookEdit also honour the vault's protected paths (sibling code path)", () => {
  const target = path.join(vault, ".obsidian", "plugins", "gryphon", "data.json");
  assert.ok(classify("MultiEdit", { file_path: target, edits: [] }, ctx()), "MultiEdit into the plugin dir");
  assert.ok(classify("NotebookEdit", { notebook_path: target, new_source: "" }, ctx()), "NotebookEdit into the plugin dir");
  assert.equal(classify("NotebookEdit", { notebook_path: path.join(vault, "nb.ipynb"), new_source: "" }, ctx()), null);
});

test("#25 review #1: read-only tools naming the store stay ungated", () => {
  assert.equal(classify("Read", { file_path: STORE }, ctx()), null);
  assert.equal(classify("Grep", { pattern: "x", path: path.dirname(STORE) }, ctx()), null);
});

test("#25 review #6 minimum: the store's deny rules exist on their own (for Protected Mode off)", () => {
  const { buildApprovalsStoreDenyGlobs } = require("../src/cc-disallow-translator");
  const globs = buildApprovalsStoreDenyGlobs();
  assert.ok(globs.includes("Bash(*mcp-approvals*)"));
  assert.ok(globs.some((g: string) => g.startsWith("Write(") && g.includes("gryphon")));
  assert.ok(globs.some((g: string) => g.startsWith("Edit(") && g.includes("gryphon")));
});

// ── issue #28 item 2: arrays, URL / cwd keys, and command args of non-shell tools ──

test("#28.2: store paths in arrays, nested edits, file:// URIs, cwd keys and command args are protected", () => {
  const { pathToFileURL } = require("url");
  const storeDir = path.dirname(STORE);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["mcp__fs__write_many", { paths: [path.join(vault, "ok.md"), STORE] }],
    ["mcp__fs__multi_edit", { edits: [{ file_path: path.join(vault, "a.md") }, { file_path: STORE }] }],
    ["mcp__fs__write", { uri: pathToFileURL(STORE).href }],
    ["mcp__shell__run", { cwd: storeDir, command: "ls" }],
    ["mcp__x__exec", { dirs: [storeDir] }],
    ["execute_command", { command: "cp x ~/.config/gryphon/mcp-approvals.json" }],
    ["mcp__shell__spawn", { args: ["sh", "-c", `echo {} > ${STORE}`] }],
    ["mcp__py__run", { code: "open('/home/u/.config/gryphon/x','w')" }],
  ];
  for (const [tool, input] of cases) {
    const v = classify(tool, input, ctx());
    assert.ok(v && v.category === "modifies-gryphon", `${tool} ${JSON.stringify(input)} → ${JSON.stringify(v)}`);
  }
  const cmd = classify("mcp__shell__spawn", { args: ["sh", "-c", "cat ~/.config/gryphon/x"] }, ctx());
  assert.match(cmd!.technicalDetail, /^Command:/m);
  const p = classify("mcp__fs__write_many", { paths: [STORE] }, ctx());
  assert.match(p!.technicalDetail, /^Target path:/m);
});

test("#28.2: content, read-only tools, and kbhost's kb_add url (URL or local path) stay unprotected", () => {
  for (const [tool, input] of [
    ["Write", { file_path: path.join(vault, "note.md"), content: "see ~/.config/gryphon/mcp-approvals.json" }],
    ["Edit", { file_path: path.join(vault, "note.md"), old_string: "a", new_string: `store is ${STORE}` }],
    ["Read", { file_path: STORE }],
    ["mcp__kbhost__kb_add", { url: "https://example.com/x" }],
    ["mcp__kbhost__kb_add", { url: "~/Documents/report.pdf" }],
    ["mcp__kbhost__kb_add_content", { content: "cp x ~/.config/gryphon/", title: "notes" }],
  ] as const) {
    assert.equal(classify(tool, input as any, ctx()), null, `${tool} ${JSON.stringify(input)}`);
  }
});

test("#28.2: walk bounds limit work, not coverage; cwd-relative, scheme-like and dst/exec names are covered", () => {
  const storeDir = path.dirname(STORE);
  const configDir = path.dirname(storeDir);
  const junk = Array.from({ length: 300 }, (_, i) => `x${i}`);
  const deep = { a: { b: { c: { d: { e: { file_path: STORE } } } } } };
  const rel = path.relative(vault, STORE);
  for (const [tool, input] of [
    ["mcp__fs__write_many", { paths: [...junk, STORE] }],
    ["mcp__fs__write", deep],
    ["mcp__fs__write", { cwd: configDir, path: `gryphon/${path.basename(STORE)}` }],
    ["mcp__fs__write", { path: `ab:/../${rel}` }],
    ["mcp__fs__copy", { src: "/tmp/a", dst: STORE }],
    ["mcp__x__run", { exec: `rm ${STORE}` }],
    ["mcp__x__run", { shell_command: "rm ~/.config/gryphon/mcp-approvals.json" }],
    ["mcp__x__run", { shellCommand: "rm ~/.config/gryphon/mcp-approvals.json" }],
    ["mcp__fs__write", { paths: [...junk, `../${rel}`], workingDirectory: path.join(vault, "sub") }],
    ["mcp__fs__write", { rootDir: [configDir], path: `gryphon/${path.basename(STORE)}` }],
  ] as const) {
    const v = classify(tool, input as any, ctx());
    assert.ok(v && v.category === "modifies-gryphon", `${tool} ${JSON.stringify(input).slice(0, 120)}`);
  }
  let nest: any = { file_path: STORE };
  for (let i = 0; i < 80; i++) nest = { n: nest };
  assert.ok(classify("mcp__fs__write", nest, ctx()), "nesting past the hard cap fails closed");
  // A large call that never names the store stays unprotected.
  assert.equal(classify("mcp__fs__write_many", { paths: junk.map((j) => path.join(vault, j)) }, ctx()), null);
});

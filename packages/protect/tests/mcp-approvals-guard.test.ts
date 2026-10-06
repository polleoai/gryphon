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

// #34: a tool Gryphon has no alias for is gated by the paths it touches.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { classify } = require("../src/attack-detector");

const SECURITY = { protectedMode: true, protectedPathsEnabled: true, protectedCommandsEnabled: true };

function withVault(fn: (vault: string) => void) {
  const vault = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "i34-"));
  try { fn(vault); } finally { fs.rmSync(vault, { recursive: true, force: true }); }
}

test("#34: an unaliased CLI file tool writing a protected path is gated", () => {
  withVault((vault) => {
    const ctx = { vaultRoot: vault, security: SECURITY };
    assert.equal(classify("multi_replace_file_content", { TargetFile: path.join(vault, ".obsidian", "plugins", "gryphon", "main.js"), ReplacementChunks: [] }, ctx)?.category, "modifies-gryphon");
    assert.equal(classify("some_new_tool", { path: ".git/hooks/pre-commit", content: "x" }, ctx)?.category, "persistent-execution");
    assert.equal(classify("mcp__fs__write_file", { dest: [`${vault}/.obsidian/plugins/gryphon/data.json`] }, ctx)?.category, "modifies-gryphon");
  });
});

test("#34: ordinary unknown tools and big MCP payloads are not prompted", () => {
  withVault((vault) => {
    const ctx = { vaultRoot: vault, security: SECURITY };
    assert.equal(classify("some_new_tool", { path: "notes/today.md", content: "hello" }, ctx), null);
    assert.equal(classify("mcp__web__fetch", { url: "https://example.com/.git/config" }, ctx), null);
    const blocks = Array.from({ length: 5000 }, (_: unknown, i: number) => ({ type: "paragraph", text: `line ${i}` }));
    assert.equal(classify("mcp__notion__append_blocks", { page_id: "x", blocks }, ctx), null);
    assert.equal(classify("Read", { file_path: `${vault}/.obsidian/plugins/gryphon/data.json` }, ctx), null);
  });
});

test("#34: switching protected paths off turns the default off too", () => {
  withVault((vault) => {
    const ctx = { vaultRoot: vault, security: { ...SECURITY, protectedPathsEnabled: false } };
    assert.equal(classify("some_new_tool", { path: ".git/hooks/pre-commit" }, ctx), null);
  });
});

test("#34 / 2.11.1 QA: the store guard doesn't refuse big MCP payloads, and still finds a buried store path", () => {
  const { approvalsStoreVerdict } = require("../src/mcp-approvals");
  const xdg = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "i34x-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const blocks = Array.from({ length: 5000 }, (_: unknown, i: number) => ({ type: "paragraph", text: `line ${i}`, annotations: { bold: false } }));
    assert.equal(approvalsStoreVerdict("mcp__notion__append_blocks", { page_id: "x", blocks }, {}), null);
    const buried = [...blocks, { type: "file", file: { path: path.join(xdg, "gryphon", "mcp-approvals.json") } }];
    assert.ok(approvalsStoreVerdict("mcp__notion__append_blocks", { page_id: "x", blocks: buried }, {}));
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});

test("#34 (dc9cc5d review): relative names resolve from the tool's own folder args; padding can't skip checks", () => {
  withVault((vault) => {
    const ctx = { vaultRoot: vault, security: SECURITY };
    fs.mkdirSync(path.join(vault, ".obsidian", "plugins", "gryphon"), { recursive: true });
    assert.equal(classify("write_into_dir", { DirectoryPath: ".obsidian/plugins/gryphon", FileName: "main.js", Content: "x" }, ctx)?.category, "modifies-gryphon");
    const padding = Array.from({ length: 3000 }, (_: unknown, i: number) => `notes/n${i}.md`);
    assert.ok(classify("bulk_write", { paths: [...padding, ".git/hooks/pre-commit"] }, ctx), "padding past the cap is refused for approval");
  });
});

test("#34 (dc9cc5d review): ~ paths are expanded like the store guard does", () => {
  const home = require("os").homedir();
  const vault = fs.mkdtempSync(path.join(home, ".gryphon-i34-"));
  try {
    const ctx = { vaultRoot: fs.realpathSync(vault), security: SECURITY };
    const rel = "~/" + path.basename(vault) + "/.git/hooks/pre-commit";
    assert.equal(classify("some_new_tool", { path: rel }, ctx)?.category, "persistent-execution");
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("#34 (97ec648 review): a URL-looking value that normalizes into the vault is still checked", () => {
  withVault((vault) => {
    const ctx = { vaultRoot: vault, security: SECURITY };
    assert.equal(classify("some_new_tool", { path: "http://x/../../.git/hooks/pre-commit" }, ctx)?.category, "persistent-execution");
    assert.equal(classify("some_new_tool", { url: "https://example.com/.git/hooks/pre-commit" }, ctx), null);
  });
});

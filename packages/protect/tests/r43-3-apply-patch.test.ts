// R43-3: Codex's apply_patch names its files inside the patch text. It was
// missing from TOOL_ALIASES, so it was treated as non-mutating (allowed with
// no gate, even with Protected Mode on) and its targets only got a text check
// (a vault symlink to the approvals store got through).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { TOOL_ALIASES, patchTargets } = require("../src/tool-aliases");
const { classify } = require("../src/attack-detector");
const { approvalsStoreVerdict } = require("../src/mcp-approvals");

const patch = (...files: string[]) => ({
  command: ["*** Begin Patch", ...files.map((f) => `*** Update File: ${f}\n@@\n-a\n+b`), "*** End Patch", ""].join("\n"),
});
const SECURITY = { protectedMode: true, protectedPathsEnabled: true, protectedCommandsEnabled: true };

test("R43-3: apply_patch is an edit tool", () => {
  assert.equal(TOOL_ALIASES.apply_patch, "Edit");
});

test("R43-3: patchTargets reads add/update/delete and move headers", () => {
  const text = [
    "*** Begin Patch",
    "*** Add File: a.md", "+x",
    "*** Update File: dir/b.md", "*** Move to: dir/c.md", "@@", "-y", "+z",
    "*** Delete File: d.md",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(patchTargets({ command: text }), ["a.md", "dir/b.md", "dir/c.md", "d.md"]);
  assert.deepEqual(patchTargets({ input: [{ patch: text }] }), ["a.md", "dir/b.md", "dir/c.md", "d.md"]);
  assert.deepEqual(patchTargets({ command: "echo hi" }), []);
});

test("R43-3: classify gates every file a patch touches", () => {
  const vault = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-3-"));
  try {
    const ctx = { vaultRoot: vault, security: SECURITY };
    assert.equal(classify("apply_patch", patch(".obsidian/plugins/gryphon/data.json"), ctx)?.category, "modifies-gryphon");
    assert.equal(classify("apply_patch", patch(".git/hooks/pre-commit"), ctx)?.category, "persistent-execution");
    // A harmless file first does not hide a protected one later in the patch.
    assert.equal(classify("apply_patch", patch("notes/a.md", ".obsidian/plugins/gryphon/main.js"), ctx)?.category, "modifies-gryphon");
    assert.equal(classify("apply_patch", patch("notes/a.md"), ctx), null);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("R43-3: a patch through a vault symlink to the approvals store is refused", () => {
  const vault = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-3v-"));
  const xdg = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-3x-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    fs.mkdirSync(path.join(xdg, "gryphon"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "gryphon", "mcp-approvals.json"), "{}");
    fs.symlinkSync(path.join(xdg, "gryphon", "mcp-approvals.json"), path.join(vault, "notes.json"));
    assert.ok(approvalsStoreVerdict("apply_patch", patch("notes.json"), { cwd: vault }));
    assert.equal(approvalsStoreVerdict("apply_patch", patch("other.md"), { cwd: vault }), null);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});

test("R43-3: a shell command given as an argv array is checked, not skipped", () => {
  const verdict = approvalsStoreVerdict("Bash", { command: ["sh", "-c", "echo {} > ~/.config/gryphon/mcp-approvals.json"] }, {});
  assert.ok(verdict);
});

test("R43-3: the bundled store-guard hook denies a patch through the symlink", () => {
  const { source } = require("../src/generated/store-guard-bundle");
  const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-3h-"));
  const xdg = path.join(work, "xdg");
  const vault = path.join(work, "vault");
  try {
    fs.mkdirSync(path.join(xdg, "gryphon"), { recursive: true });
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(xdg, "gryphon", "mcp-approvals.json"), "{}");
    fs.symlinkSync(path.join(xdg, "gryphon", "mcp-approvals.json"), path.join(vault, "notes.json"));
    const script = path.join(work, "store-guard.js");
    fs.writeFileSync(script, source);
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: patch("notes.json"), cwd: vault });
    const out = execFileSync(process.execPath, [script, "codex", path.join(xdg, "gryphon")], {
      input: payload, encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: xdg },
    });
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// Follow-up to the commit security review: patchTargets must read at least
// what Codex reads — headers after a full Unicode trim, CRLF line endings,
// `Move to:` after trim_end — and shell `apply_patch <<EOF` commands.
test("R43-3b: indented, CRLF and Unicode-padded headers are still read", () => {
  const crlf = "*** Begin Patch\r\n*** Update File: a.json\r\n@@\r\n-x\r\n+y\r\n*** End Patch\r\n";
  assert.deepEqual(patchTargets({ command: crlf }), ["a.json"]);
  const indented = "*** Begin Patch\n   *** Update File: b.json\n@@\n-x\n+y\n\t*** Delete File: c.json\n*** End Patch";
  assert.deepEqual(patchTargets({ command: indented }).sort(), ["b.json", "c.json"]);
  const nel = "*** Begin Patch\n\u0085　*** Add File: d.json \n+x\n*** End Patch";
  assert.ok(patchTargets({ command: nel }).includes("d.json"));
  const moved = "*** Begin Patch\n*** Update File: e.md\n*** Move to: f.json   \n@@\n-x\n+y\n*** End Patch";
  assert.ok(patchTargets({ command: moved }).includes("f.json"));
});

test("R43-3b: a shell `apply_patch <<EOF` through the store symlink is refused, and protected files classified", () => {
  const vault = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-3b-"));
  const xdg = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-3bx-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    fs.mkdirSync(path.join(xdg, "gryphon"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "gryphon", "mcp-approvals.json"), "{}");
    fs.symlinkSync(path.join(xdg, "gryphon", "mcp-approvals.json"), path.join(vault, "notes.json"));
    const shell = (f: string) => ({ command: `apply_patch <<'EOF'\n*** Begin Patch\n  *** Update File: ${f}\n@@\n-a\n+b\n*** End Patch\nEOF` });
    assert.ok(approvalsStoreVerdict("Bash", shell("notes.json"), { cwd: vault }));
    assert.equal(approvalsStoreVerdict("Bash", shell("ok.md"), { cwd: vault }), null);
    assert.equal(classify("Bash", shell(".obsidian/plugins/gryphon/main.js"), { vaultRoot: vault, security: SECURITY })?.category, "modifies-gryphon");
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});

// Commit-review round 2 on the apply_patch fix.
test("R43-3c: a patch too large to scan fails closed (store guard and classify)", () => {
  const { patchTargetsInfo } = require("../src/tool-aliases");
  const many = ["*** Begin Patch", ...Array.from({ length: 2100 }, (_: unknown, i: number) => `*** Delete File: f${i}.md`), "*** End Patch"].join("\n");
  assert.equal(patchTargetsInfo({ command: many }).truncated, true);
  assert.ok(approvalsStoreVerdict("apply_patch", { command: many }, {}));
  const vault = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-3c-"));
  try {
    assert.ok(classify("apply_patch", { command: many }, { vaultRoot: vault, security: SECURITY }));
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("R43-3c: relative patch paths resolve from workdir args and shell `cd` too", () => {
  const vault = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-3d-"));
  try {
    fs.mkdirSync(path.join(vault, "notes", "deep"), { recursive: true });
    const ctx = { vaultRoot: vault, security: SECURITY };
    const p = "*** Begin Patch\n*** Update File: ../../.obsidian/plugins/gryphon/data.json\n@@\n-a\n+b\n*** End Patch";
    assert.equal(classify("apply_patch", { command: p, workdir: "notes/deep" }, ctx)?.category, "modifies-gryphon");
    assert.equal(classify("Bash", { command: `cd notes/deep && apply_patch <<'EOF'\n${p}\nEOF` }, ctx)?.category, "modifies-gryphon");
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("R43-3c: the most severe match wins and the others are named", () => {
  const vault = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r43-3e-"));
  try {
    const ctx = { vaultRoot: vault, security: SECURITY };
    const v = classify("apply_patch", patch(".git/hooks/pre-commit", ".obsidian/plugins/gryphon/data.json"), ctx);
    assert.equal(v?.category, "modifies-gryphon");
    assert.match(v.technicalDetail, /Also matched:/);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

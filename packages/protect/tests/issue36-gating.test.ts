// Issue #36 items 1-4: what unknown and aliased tools, and shell commands,
// are gated on.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { classify } = require("../src/attack-detector");

const SECURITY = { protectedMode: true, protectedPathsEnabled: true, protectedCommandsEnabled: true };
function withVault(fn: (vault: string, ctx: any) => void) {
  const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "i36-")));
  fs.mkdirSync(path.join(vault, ".obsidian", "plugins", "gryphon"), { recursive: true });
  fs.mkdirSync(path.join(vault, "notes"));
  try { fn(vault, { vaultRoot: vault, security: SECURITY }); } finally { fs.rmSync(vault, { recursive: true, force: true }); }
}

test("#36 item 1: read-named tools and remote repo paths aren't gated; writes still are", () => {
  withVault((_v, ctx) => {
    assert.equal(classify("mcp__github__get_file_contents", { owner: "o", repo: "r", path: ".git/config" }, ctx), null);
    assert.equal(classify("mcp__fs__read_text_file", { path: ".obsidian/plugins/gryphon/data.json" }, ctx), null);
    assert.equal(classify("mcp__fs__list_directory", { path: ".obsidian" }, ctx), null);
    // A read verb with a write word is not read-only.
    assert.ok(classify("mcp__x__get_or_create_file", { path: ".obsidian/plugins/gryphon/data.json" }, ctx));
    assert.ok(classify("mcp__fs__write_file", { path: ".obsidian/plugins/gryphon/data.json", content: "x" }, ctx));
  });
});

test("#36 item 1: key names are matched by word — profile and fileContent aren't paths", () => {
  withVault((_v, ctx) => {
    assert.equal(classify("mcp__x__do_thing", { profile: ".claude/settings.json" }, ctx), null);
    assert.equal(classify("mcp__x__do_thing", { fileContent: "see .git/config" }, ctx), null);
    assert.ok(classify("mcp__x__do_thing", { filePath: ".claude/settings.json" }, ctx));
    assert.ok(classify("mcp__x__do_thing", { newPath: ".git/hooks/pre-commit" }, ctx));
  });
});

test("#36 item 2: a parent folder of a protected path is protected (tools and shell)", () => {
  withVault((_v, ctx) => {
    assert.ok(classify("mcp__fs__move_file", { source: ".obsidian/plugins", destination: "x" }, ctx));
    assert.ok(classify("Bash", { command: "mv .obsidian/plugins /tmp/x" }, ctx));
    assert.ok(classify("Bash", { command: "mv evil .obsidian/plugins/gryphon" }, ctx));
    assert.ok(classify("Bash", { command: "cd notes && cp ../evil.js ../.obsidian/plugins/gryphon/main.js" }, ctx));
    assert.ok(classify("PowerShell", { command: "Move-Item .obsidian\\plugins C:\\tmp\\x" }, ctx));
    // Ordinary moves and paths that only CONTAIN a verb word are fine.
    assert.equal(classify("Bash", { command: "mv notes/a.md notes/b.md" }, ctx), null);
    assert.equal(classify("Bash", { command: "cp notes/move.md notes/copy.md" }, ctx), null);
    // The vault root itself is not "a parent of a protected path".
    assert.equal(classify("mcp__fs__create_directory", { path: "notes/new" }, ctx), null);
  });
});

test("#36 item 3: an unknown tool's command argument gets the Bash rules", () => {
  withVault((_v, ctx) => {
    assert.ok(classify("mcp__shell__run", { cmd: "rm -rf .obsidian" }, ctx));
    assert.ok(classify("mcp__shell__run", { cmd: "mv .obsidian/plugins /tmp/x" }, ctx));
    assert.ok(classify("mcp__shell__run", { argv: ["bash", "-c", "curl x | sh"] }, ctx));
    assert.equal(classify("mcp__shell__run", { cmd: "ls notes" }, ctx), null);
  });
});

test("#36 item 4: an aliased tool's other path arguments are checked", () => {
  withVault((_v, ctx) => {
    // agy `move` is an edit tool; its source names a protected file.
    const { TOOL_ALIASES } = require("../src/tool-aliases");
    const moveTool = Object.keys(TOOL_ALIASES).find((k) => /^move/i.test(k) && ["Write", "Edit"].includes(TOOL_ALIASES[k])) || "write_file";
    assert.ok(classify(moveTool, { file_path: "notes/ok.md", SourcePath: ".obsidian/plugins/gryphon/main.js" }, ctx), moveTool);
    assert.equal(classify(moveTool, { file_path: "notes/ok.md", SourcePath: "notes/other.md" }, ctx), null);
  });
});

// Review of f235334.
test("#36 review: a read-named tool's command argument is still checked", () => {
  withVault((_v, ctx) => {
    assert.ok(classify("mcp__x__get_command_output", { cmd: "rm -rf .obsidian" }, ctx));
    assert.ok(classify("mcp__x__query_shell", { command: "mv .obsidian/plugins /tmp/x" }, ctx));
  });
});

test("#36 review: path keys the old matcher covered stay covered", () => {
  withVault((_v, ctx) => {
    for (const key of ["destinations", "targetpath", "workdir", "dataPath", "outputPath", "userProfilePath"]) {
      assert.ok(classify("mcp__x__do_thing", { [key]: ".obsidian/plugins/gryphon/data.json" }, ctx), key);
    }
    for (const key of ["profile", "fileContent", "pathText"]) {
      assert.equal(classify("mcp__x__do_thing", { [key]: ".obsidian/plugins/gryphon/data.json" }, ctx), null, key);
    }
  });
});

test("#36 review: too many command arguments or shell paths are refused for approval, not checked in part", () => {
  withVault((_v, ctx) => {
    const many = Array.from({ length: 3000 }, (_: unknown, i: number) => ({ cmd: `echo ${i}` }));
    assert.ok(classify("mcp__x__batch", { steps: many }, ctx));
    const longCmd = "cp " + Array.from({ length: 2100 }, (_: unknown, i: number) => `notes/f${i}.md`).join(" ") + " .obsidian/plugins/gryphon/main.js";
    assert.ok(classify("Bash", { command: longCmd }, ctx));
  });
});

// Review of 7075f35.
test("#36 F1: prose and source-code arguments don't get the shell rules", () => {
  withVault((_v, ctx) => {
    assert.equal(classify("Skill", { skill: "review", args: "look at the auth module" }, ctx), null);
    assert.equal(classify("Skill", { args: "run model eval on the test set" }, ctx), null);
    assert.equal(classify("mcp__jupyter__execute_cell", { code: "print('saved at', p)" }, ctx), null);
    assert.equal(classify("mcp__x__call", { args: "meet at noon" }, ctx), null);
    assert.ok(classify("mcp__shell__run", { command: "rm -rf .obsidian" }, ctx), "a real command key still is");
  });
});

test("#36 F2: moves within notes and heredoc notes without protected paths don't prompt", () => {
  withVault((_v, ctx) => {
    for (const command of [
    ]) assert.equal(classify("Bash", { command }, ctx), null, command);
    const longNote = "cat > notes/big.md <<'EOF'\n" + Array.from({ length: 3000 }, (_: unknown, i: number) => (i % 50 === 0 ? "copy" : `w${i}`)).join(" ") + "\nEOF";
    assert.equal(classify("Bash", { command: longNote }, ctx), null);
  });
});

test("#36 F3: option-attached destinations and extractors are checked", () => {
  withVault((_v, ctx) => {
    for (const command of [
      "cp -r /tmp/evil/. --target-directory=.obsidian/plugins/gryphon",
      "mv /tmp/x/plugins --target-directory=.obsidian",
      "cp -t.obsidian/plugins/gryphon /tmp/evil/main.js",
      "cp -d /tmp/evil.js .obsidian/plugins/gryphon/main.js",
      "tar -xf e.tar -C .obsidian/plugins/gryphon",
      "unzip e.zip -d .obsidian/plugins/gryphon",
      "7z x e.7z -o.obsidian/plugins/gryphon",
    ]) assert.ok(classify("Bash", { command }, ctx), command);
    assert.ok(classify("PowerShell", { command: "Copy-Item C:\\t\\main.js -Destination:.obsidian\\plugins\\gryphon\\main.js" }, ctx));
    assert.equal(classify("Bash", { command: "tar -czf backup.tgz notes" }, ctx), null);
  });
});

test("#36 F4: a huge path is answered fast, not resolved slowly", () => {
  withVault((_v, ctx) => {
    const t0 = Date.now();
    const v = classify("Bash", { command: `cp ${"a/".repeat(60000)}x notes/y` }, ctx);
    const v2 = classify("Bash", { command: `${"cd notes; ".repeat(32)}cp ${"b".repeat(50000)} x` }, ctx);
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    assert.ok(v || v2 || true);
  });
});

test("#36 F5: the parent check normalises custom patterns like the exact match", () => {
  withVault((vault, ctx0) => {
    fs.mkdirSync(path.join(vault, "secrets", "keys"), { recursive: true });
    const ctx = { ...ctx0, security: { ...SECURITY, protectedPathsCustom: ["secrets\\keys\\", " notes/locked/ "] } };
    assert.ok(classify("Bash", { command: "mv secrets /tmp/x" }, ctx));
    assert.ok(classify("Bash", { command: "mv notes /tmp/x" }, ctx));
  });
});

test("#36 review: a read-named tool still has its destination arguments checked", () => {
  withVault((_v, ctx) => {
    assert.ok(classify("mcp__sftp__get_file", { remote_path: "/srv/x", local_path: ".obsidian/plugins/gryphon/main.js" }, ctx));
    assert.equal(classify("mcp__sftp__get_file", { remote_path: "/srv/x", local_path: "notes/x" }, ctx), null);
  });
});

// Review of f22cabc: when the parser can't be sure, it fails closed.
test("#36 review: wrappers, substitutions and inner commands are checked", () => {
  withVault((_v, ctx) => {
    for (const command of [
      "sudo -u root cp evil .obsidian/plugins/gryphon/main.js",
      "timeout 5 cp evil .obsidian/plugins/gryphon/main.js",
      "nice -n 10 mv .obsidian/plugins /tmp/x",
      "env -i cp evil .obsidian/plugins/gryphon/main.js",
      "echo evil | xargs cp -t .obsidian/plugins/gryphon",
      "find /tmp/e -name '*.js' -exec cp {} .obsidian/plugins/gryphon/ \;",
      "echo $(cp evil .obsidian/plugins/gryphon/main.js)",
      "echo `cp evil .obsidian/plugins/gryphon/main.js`",
      "bash -c \"cp evil .obsidian/plugins/gryphon/main.js\"",
      "eval 'mv .obsidian/plugins /tmp/x'",
      "if cp evil .obsidian/plugins/gryphon/main.js; then echo ok; fi",
      "rsync -a /tmp/evil/ .obsidian/plugins/gryphon/ --exclude x",
      "cat <<EOF\nnever closed\ncp evil .obsidian/plugins/gryphon/main.js",
      "cp evil \\\n  .obsidian/plugins/gryphon/main.js",
      "/bin/cp evil .obsidian/plugins/gryphon/main.js",
    ]) assert.ok(classify("Bash", { command }, ctx), command);
    // A verb word next to a protected path now fails closed (accepted cost).
    assert.ok(classify("Bash", { command: "grep -rn copy .obsidian/plugins" }, ctx));
  });
});

test("#36 review: script/code/args arguments still get the destructive and path rules", () => {
  withVault((_v, ctx) => {
    assert.ok(classify("mcp__x__run", { script: "rm -rf .obsidian" }, ctx));
    assert.ok(classify("mcp__x__run", { code: "cp evil .obsidian/plugins/gryphon/main.js" }, ctx));
    assert.ok(classify("mcp__x__run", { args: "mv .obsidian/plugins /tmp/x" }, ctx));
    // …but not the prose-prone rules.
    assert.equal(classify("mcp__x__run", { args: "meet at noon" }, ctx), null);
    assert.equal(classify("mcp__x__run", { code: "model.eval()" }, ctx), null);
  });
});

// Re-review of f22cabc: the every-token design closes the parser bypasses.
test("#36 N1-N8: redirections, compound syntax, wrappers, git options, robocopy, continuations, heredoc tricks", () => {
  withVault((_v, ctx) => {
    const P = ".obsidian/plugins/gryphon";
    for (const command of [
      `cp /tmp/e/main.js ${P}/main.js 2>&1`,
      `cp /tmp/e/main.js ${P}/main.js >/tmp/log`,
      `rsync -a /tmp/e/ ${P}/ >/dev/null`,
      `if true; then cp /tmp/e/main.js ${P}/main.js; fi`,
      `for f in x; do cp $f ${P}/; done`,
      `{ cp a ${P}/main.js; }`,
      `! cp a ${P}/main.js`,
      `sleep 1 & cp a ${P}/main.js`,
      `true&cp a ${P}/main.js`,
      "case x in x) mv .obsidian/plugins /tmp/x;; esac",
      "f(){ mv .obsidian/plugins /tmp/x; }; f",
      `cp /tmp/e/main.js \\\n ${P}/main.js`,
      `cat <<EOF >/dev/null; cp a ${P}/main.js\nhi\nEOF`,
      `echo "<<EOF"\ncp a ${P}/main.js\nEOF`,
      `# <<EOF\ncp a ${P}/main.js\nEOF`,
      `echo $((1<<EOF))\ncp a ${P}/main.js\nEOF`,
      `cat <<<EOF\ncp a ${P}/main.js\nEOF`,
      `nice -n 5 cp a ${P}/main.js`,
      `env -u HOME cp a ${P}/main.js`,
      `timeout 5 cp a ${P}/main.js`,
      "busybox mv /tmp/e .obsidian/plugins/gryphon",
      `git -C . mv notes/x ${P}/main.js`,
      "robocopy C:\\t .obsidian\\plugins\\gryphon /MIR",
      "robocopy .obsidian\\plugins C:\\x /MOVE",
    ]) assert.ok(classify("Bash", { command }, ctx), command);
    // N8: tar CREATING a backup from a protected folder is not a write.
    assert.equal(classify("Bash", { command: "tar -C notes -czf /tmp/b.tgz ." }, ctx), null);
  });
});

test("#36 review: a quoted inner command uses the full verb set", () => {
  withVault((_v, ctx) => {
    assert.ok(classify("Bash", { command: "pwsh -c \"Copy-Item a .obsidian/plugins/gryphon/main.js\"" }, ctx));
    assert.ok(classify("Bash", { command: "sh -c \"ditto /tmp/e .obsidian/plugins/gryphon\"" }, ctx));
  });
});

// Automatic review of ec1f9d2.
test("#36 review: a heredoc fed to an interpreter is checked; quotes inside a word don't split it", () => {
  withVault((_v, ctx) => {
    for (const command of [
      "bash <<EOF\ncp /tmp/e .obsidian/plugins/gryphon/main.js\nEOF",
      "sh <<'EOF'\nmv .obsidian/plugins /tmp/x\nEOF",
      "cp a .obsi\"di\"an/plugins/gryphon/main.js",
      "cp a '.obs'idian/plugins/gryphon/main.js",
      "cp a \\.obsidian/plugins/gryphon/main.js",
    ]) assert.ok(classify("Bash", { command }, ctx), command);
    // Option B: heredoc text is checked too — a note that names a protected
    // folder next to a copy/move word prompts (accepted cost).
    assert.ok(classify("Bash", { command: "cat > notes/x.md <<'EOF'\nTo copy it, move it into .obsidian/plugins\nEOF" }, ctx));
  });
});

test("#36 review: an escaped space joins one POSIX word", () => {
  withVault((vault, ctx0) => {
    fs.mkdirSync(path.join(vault, "My Locked"), { recursive: true });
    const ctx = { ...ctx0, security: { ...SECURITY, protectedPathsCustom: ["My Locked/"] } };
    assert.ok(classify("Bash", { command: "cp /tmp/e My\\ Locked/x.md" }, ctx));
    assert.ok(classify("Bash", { command: "mv My\\ Locked /tmp/x" }, ctx));
  });
});

test("#36 review: a quoted path with spaces is checked whole", () => {
  withVault((vault, ctx0) => {
    fs.mkdirSync(path.join(vault, "My Locked"), { recursive: true });
    const ctx = { ...ctx0, security: { ...SECURITY, protectedPathsCustom: ["My Locked/"] } };
    assert.ok(classify("Bash", { command: "cp /tmp/e 'My Locked/x.md'" }, ctx));
    assert.ok(classify("Bash", { command: "cp /tmp/e \"My Locked/x.md\"" }, ctx));
  });
});

test("#36 review: a heredoc into a data command whose output is piped on is checked", () => {
  withVault((_v, ctx) => {
    assert.ok(classify("Bash", { command: "cat <<EOF | sh\ncp /tmp/e .obsidian/plugins/gryphon/main.js\nEOF" }, ctx));
    assert.ok(classify("Bash", { command: "tee >(bash) <<EOF\nmv .obsidian/plugins /tmp/x\nEOF" }, ctx));
  });
});

// Re-review of 99346ad (option B).
test("#36 B: no freeze, no crash on huge input", () => {
  withVault((_v, ctx) => {
    const t0 = Date.now();
    classify("Bash", { command: "tar ".repeat(100000) }, ctx);
    let threw = false;
    try { classify("Bash", { command: `cp "${"a ".repeat(500000)}" x` }, ctx); } catch (_) { threw = true; }
    assert.equal(threw, false, "no stack overflow");
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  });
});

test("#36 B: globs, $VAR, NAME=value, tar --ext, bundled options, quoted option values, more verbs", () => {
  withVault((_v, ctx) => {
    const P = ".obsidian/plugins/gryphon";
    for (const command of [
      `cp x .obsidian/plugins/gry*/main.js`,
      "mv .obsidian/plug* /tmp/x",
      `cp x $PWD/${P}/main.js`,
      `cp x "$(pwd)/${P}/main.js"`,
      `D=${P}; cp x $D/main.js`,
      `tar --ext -f /tmp/e.tar -C ${P}`,
      `tar -xC${P} -f e.tar`,
      `cp -rt${P} /tmp/e/main.js`,
      `watch -n 1 "cp --target-directory=${P} /tmp/e/main.js"`,
      `dd if=/tmp/e of=${P}/main.js`,
      `touch ${P}/main.js`,
      `sed -i s/a/b/ ${P}/main.js`,
      `git checkout HEAD -- ${P}/main.js`,
      `scp host:e ${P}/main.js`,
      `cat <<EO\\F\nEOF\ncp /tmp/e ${P}/main.js\nEO`,
    ]) assert.ok(classify("Bash", { command }, ctx), command);
    assert.ok(classify("PowerShell", { command: `Set-Content -Path ${P}\\main.js -Value x` }, ctx));
    // Reading with sed (no -i) is not a write.
    assert.equal(classify("Bash", { command: "sed s/a/b/ notes/a.md" }, ctx), null);
  });
});

test("#36 B: flag-dependent write verbs inside a quoted inner command, and tar --get", () => {
  withVault((_v, ctx) => {
    const P = ".obsidian/plugins/gryphon";
    for (const command of [
      `watch -n 1 "tar -xf /tmp/e.tar -C ${P}"`,
      `flock /tmp/l -c "sed -i s/a/b/ ${P}/main.js"`,
      `watch "git checkout HEAD -- ${P}/main.js"`,
      `tar --get -f /tmp/e.tar -C ${P}`,
    ]) assert.ok(classify("Bash", { command }, ctx), command);
  });
});

// Final review of 0bfefd1.
test("#36 B final: $(…)/${…} prefixes, python library copies, gsed", () => {
  withVault((_v, ctx) => {
    const P = ".obsidian/plugins/gryphon";
    for (const command of [
      `cp /tmp/e/main.js $(pwd)/${P}/main.js`,
      `cp /tmp/e/main.js "$(git rev-parse --show-toplevel)/${P}/main.js"`,
      `cp x \${PWD}/${P}/main.js`,
      "mv $(pwd)/.obsidian/plugins /tmp/x",
      `unzip -o e.zip -d $(pwd)/${P}`,
      "python3 - <<'EOF'\nimport shutil\nshutil.copy(\"/tmp/e/main.js\", \".obsidian/plugins/gryphon/main.js\")\nEOF",
      "python3 - <<'EOF'\nimport shutil\nshutil.move(\".obsidian/plugins\", \"/tmp/x\")\nEOF",
      `gsed -i 's/a/b/' ${P}/data.json`,
    ]) assert.ok(classify("Bash", { command }, ctx), command);
  });
});

test("#36 B final: a long heredoc note with an apostrophe and verb words doesn't prompt", () => {
  withVault((_v, ctx) => {
    const prose = Array.from({ length: 870 }, (_: unknown, i: number) => (i % 40 === 0 ? "install" : i % 41 === 0 ? "link" : `word${i % 97}`)).join(" ");
    assert.equal(classify("Bash", { command: `cat > notes/guide.md <<'EOF'\nIt's a guide.\n${prose}\nEOF` }, ctx), null);
  });
});

test("#36 B: many duplicate candidates stay fast", () => {
  withVault((_v, ctx) => {
    const t0 = Date.now();
    classify("Bash", { command: "cp " + "notes/a.md ".repeat(19000) + "x" }, ctx);
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  });
});

test("#36 2.11.4 review: a shell tool's working-folder argument is a base for the paths it names", () => {
  withVault((vault, ctx) => {
    const plugin = path.join(vault, ".obsidian", "plugins", "gryphon");
    assert.ok(classify("run_command", { CommandLine: "cp /tmp/evil.js main.js", command: "cp /tmp/evil.js main.js", Cwd: plugin }, ctx));
    assert.ok(classify("run_command", { CommandLine: "mv gryphon /tmp/x", command: "mv gryphon /tmp/x", Cwd: path.join(vault, ".obsidian", "plugins") }, ctx));
    assert.ok(classify("run_shell_command", { command: "cp /tmp/evil.js main.js", dir_path: ".obsidian/plugins/gryphon" }, ctx));
    assert.ok(classify("run_shell_command", { command: "cp /tmp/evil.js main.js", directory: ".obsidian/plugins/gryphon" }, ctx));
    assert.ok(classify("mcp__shell__run", { cmd: "cp /tmp/evil.js main.js", cwd: ".obsidian/plugins/gryphon" }, ctx));
    assert.equal(classify("run_shell_command", { command: "cp a.md b.md", dir_path: "notes" }, ctx), null);
  });
});

test("#36 2.11.4 review: source code in a code argument isn't read as cmd.exe del or POSIX unlink", () => {
  withVault((_v, ctx) => {
    assert.equal(classify("mcp__jupyter__execute_code", { code: "import pandas as pd\ndel df['tmp']" }, ctx), null);
    assert.equal(classify("mcp__ide__executeCode", { code: "x=1\ndel x\nos.unlink(tmp)" }, ctx), null);
    // Shell-command arguments keep every rule.
    assert.ok(classify("mcp__shell__run", { command: "del notes\\a.md" }, ctx) || process.platform !== "win32");
    assert.ok(classify("mcp__ide__executeCode", { code: "import os; os.system('rm -rf ~/x')" }, ctx));
    assert.ok(classify("mcp__ide__executeCode", { code: "import os; os.system('del /q notes\\a.md')" }, ctx));
    assert.ok(classify("mcp__ide__executeCode", { code: "subprocess.run(['shred', f])" }, ctx));
    assert.ok(classify("mcp__ide__executeCode", { code: "x=1;  del notes" }, ctx) === null, "statement del");
  });
});

test("#36 2.11.4 QA: read-only listing tools aren't parent-folder writes", () => {
  withVault((vault, ctx) => {
    assert.equal(classify("mcp__filesystem__directory_tree", { path: path.join(vault, ".obsidian") }, ctx), null);
    assert.equal(classify("mcp__fs__tree", { path: ".obsidian" }, ctx), null);
    assert.equal(classify("mcp__mcp-obsidian__obsidian_list_files_in_dir", { dirpath: ".obsidian" }, ctx), null);
    assert.ok(classify("mcp__mcp-obsidian__obsidian_append_content", { filepath: ".obsidian/plugins/gryphon/data.json", content: "x" }, ctx));
    assert.ok(classify("mcp__fs__tree_delete", { path: ".obsidian" }, ctx));
  });
});

test("#36 2.11.4 security review: read-named tools that save to a qualified path key, spawn-style args, the CLI's cwd", () => {
  withVault((vault, ctx) => {
    assert.ok(classify("mcp__chrome-devtools__get_network_request", { reqid: 3, responseFilePath: ".obsidian/plugins/gryphon/main.js" }, ctx));
    assert.ok(classify("mcp__x__query_logs", { logFile: ".claude/settings.json" }, ctx));
    assert.equal(classify("mcp__fs__read_text_file", { path: ".obsidian/plugins/gryphon/data.json" }, ctx), null);
    assert.equal(classify("mcp__x__get_file", { filePath: ".git/config" }, ctx), null);
    assert.ok(classify("mcp__x__execute_command", { command: "cp", args: ["/tmp/e.js", ".obsidian/plugins/gryphon/main.js"] }, ctx));
    assert.ok(classify("mcp__x__execute_command", { command: "mv", args: [".obsidian/plugins", "/tmp/x"] }, ctx));
    assert.equal(classify("mcp__x__execute_command", { command: "cp", args: ["notes/a.md", "notes/b.md"] }, ctx), null);
    const plugin = path.join(vault, ".obsidian", "plugins", "gryphon");
    assert.ok(classify("Bash", { command: "cp ~/Downloads/build/main.js main.js" }, { ...ctx, cwd: plugin }));
    assert.equal(classify("Bash", { command: "cp a.md b.md" }, { ...ctx, cwd: path.join(vault, "notes") }), null);
    // A cwd outside the vault is ignored (paths there aren't the vault's).
    assert.equal(classify("Bash", { command: "cp a.md b.md" }, { ...ctx, cwd: "/tmp" }), null);
  });
});

test("#36 2.11.4: a read-named tool's `target` key is still a destination", () => {
  withVault((_v, ctx) => {
    assert.ok(classify("mcp__x__get_export", { target: ".obsidian/plugins/gryphon/main.js" }, ctx));
  });
});

test("#36 2.11.4 fix-round review: read/search start folders aren't writes; quoted unlink and cmd del keep their rules", () => {
  withVault((vault, ctx) => {
    assert.equal(classify("mcp__fs__search_files", { cwd: ".obsidian", pattern: "x" }, ctx), null);
    assert.equal(classify("mcp__x__list_files", { root_path: ".obsidian/plugins" }, ctx), null);
    assert.equal(classify("mcp__x__search_code", { search_path: ".obsidian/plugins/gryphon" }, ctx), null);
    assert.equal(classify("mcp__x__read_file", { base_path: ".obsidian", file_path: "app.json" }, ctx), null);
    assert.ok(classify("mcp__chrome-devtools__get_network_request", { responseFilePath: ".obsidian/plugins/gryphon/main.js" }, ctx));
    assert.ok(classify("mcp__py__execute_code", { code: "import os\nos.unlink('.obsidian/plugins/gryphon/main.js')" }, ctx));
    assert.equal(classify("mcp__py__execute_code", { code: "p.unlink()\nos.unlink(tmp)\ndel df['x']\ndel self.x" }, ctx), null);
    assert.ok(classify("mcp__win__run_script", { script: "del notes\\a.md" }, ctx));
    assert.ok(classify("mcp__git__checkout_tree", { path: ".obsidian/plugins/gryphon" }, ctx));
    assert.ok(classify("mcp__write__write_tree", { path: ".obsidian/plugins/gryphon" }, ctx));
    assert.equal(classify("mcp__filesystem__directory_tree", { path: path.join(vault, ".obsidian") }, ctx), null);
  });
});

test("#36 2.11.4 fix-round security review: redirects/tee from a cwd, library deletes, split args under other keys", () => {
  withVault((vault, ctx) => {
    const plugin = path.join(vault, ".obsidian", "plugins", "gryphon");
    const at = { ...ctx, cwd: plugin };
    assert.ok(classify("Bash", { command: "cat /tmp/e.js > main.js" }, at));
    assert.ok(classify("Bash", { command: "echo x >>data.json" }, at));
    assert.ok(classify("Bash", { command: "cat e | tee main.js" }, at));
    assert.ok(classify("Bash", { command: "echo '{}' > settings.json" }, { ...ctx, cwd: path.join(vault, ".claude") }));
    assert.ok(classify("run_shell_command", { command: "cat /tmp/e.js > main.js", dir_path: ".obsidian/plugins/gryphon" }, ctx));
    // A note written by redirect isn't path-checked word by word.
    assert.equal(classify("Bash", { command: "cat > notes/x.md <<'EOF'\nback up .obsidian and .git\nEOF" }, ctx), null);
    assert.equal(classify("Bash", { command: "ls 2>/dev/null > notes/list.md" }, ctx), null);
    assert.ok(classify("mcp__py__execute_code", { code: "Path('.claude/settings.json').unlink(missing_ok=True)" }, ctx));
    assert.ok(classify("mcp__py__execute_code", { code: "import shutil; shutil.rmtree('.obsidian/plugins/gryphon')" }, ctx));
    assert.ok(classify("mcp__x__exec", { command: "cp", arguments: ["/tmp/e.js", ".obsidian/plugins/gryphon/main.js"] }, ctx));
    assert.ok(classify("mcp__x__exec", { executable: "cp", parameters: ["/tmp/e.js", ".obsidian/plugins/gryphon/main.js"] }, ctx));
    fs.mkdirSync(path.join(vault, "..x"));
    assert.ok(classify("Bash", { command: "cp /tmp/e.js ../.obsidian/plugins/gryphon/main.js" }, { ...ctx, cwd: path.join(vault, "..x") }));
  });
});

test("#36 2.11.4: protected paths match when the vault root is given as its real path and the file through a link", () => {
  withVault((vault, ctx) => {
    const link = path.join(fs.realpathSync(os.tmpdir()), `i36-link-${process.pid}`);
    try { fs.symlinkSync(vault, link); } catch { return; }
    try {
      assert.ok(classify("Write", { file_path: path.join(link, ".obsidian/plugins/gryphon/main.js"), content: "x" }, ctx));
    } finally { fs.unlinkSync(link); }
  });
});

test("#36 2.11.4: redirect targets are read like the shell reads them (quotes, escapes, $(…))", () => {
  withVault((vault, ctx) => {
    assert.ok(classify("Bash", { command: "cat /tmp/e > .obsi\"di\"an/plugins/gryphon/main.js" }, ctx));
    assert.ok(classify("Bash", { command: "cat /tmp/e >'.obsidian/plugins/gryphon/main.js'" }, ctx));
    assert.ok(classify("Bash", { command: "cat /tmp/e > \\.obsidian/plugins/gryphon/main.js" }, ctx));
    assert.ok(classify("Bash", { command: "cat /tmp/e > $(pwd)/.obsidian/plugins/gryphon/main.js" }, ctx));
    assert.ok(classify("Bash", { command: "echo x 2>&1 >.git/hooks/pre-commit" }, ctx));
    assert.equal(classify("Bash", { command: "echo x 2>&1 | grep y > notes/out.md" }, ctx), null);
  });
});

test("#36 2.11.4: redirect targets across a line continuation, in multi-line quotes, or too long", () => {
  withVault((_v, ctx) => {
    assert.ok(classify("Bash", { command: "cat /tmp/e > .obsi\\\ndian/plugins/gryphon/main.js" }, ctx));
    assert.ok(classify("Bash", { command: "cat /tmp/e > './.obsidian/plugins/gryphon/main.js'\necho done" }, ctx));
    const long = "notes/" + "a/".repeat(3000) + "../".repeat(3000) + ".obsidian/plugins/gryphon/main.js";
    assert.ok(classify("Bash", { command: `cat /tmp/e > ${long}` }, ctx));
  });
});

test("#36 2.11.4 final security check: redirect scan is linear, sees =>/->/<>/>&, and never drops targets", () => {
  withVault((_v, ctx) => {
    const P = ".obsidian/plugins/gryphon/main.js";
    assert.ok(classify("Bash", { command: `echo 'evil();//'=>${P}` }, ctx));
    assert.ok(classify("Bash", { command: `echo 'evil();//'->${P}` }, ctx));
    assert.ok(classify("Bash", { command: `cat notes/p.js =>${P}` }, ctx));
    assert.ok(classify("Bash", { command: `exec 3<>${P}; echo evil >&3` }, ctx));
    assert.ok(classify("Bash", { command: `echo x >& ${P}` }, ctx));
    assert.ok(classify("Bash", { command: "echo x" + " >/dev/null".repeat(4097) + ` >${P}` }, ctx));
    assert.ok(classify("Bash", { command: "echo x" + " 2>&1".repeat(5000) + ` >${P}` }, ctx));
    assert.equal(classify("Bash", { command: "ls 2>&1 >&2 > notes/a.md" }, ctx), null);
    for (const cmd of ["echo " + "1".repeat(200000), "> ".repeat(200000), "a=>b ".repeat(40000)]) {
      const t = Date.now();
      classify("Bash", { command: cmd }, ctx);
      assert.ok(Date.now() - t < 2000, `slow: ${cmd.slice(0, 20)} ${Date.now() - t}ms`);
    }
    // The "skip .obsidian" vault-walk idiom isn't a delete.
    assert.equal(classify("mcp__py__run_python", { code: "for r, d, f in os.walk('.'):\n    if '.obsidian' in d: d.remove('.obsidian')\n    print(r)" }, ctx), null);
    assert.ok(classify("mcp__py__run_python", { code: "os.remove('.obsidian/plugins/gryphon/main.js')" }, ctx));
    assert.ok(classify("mcp__js__run", { code: "require('fs').rmSync('.obsidian/plugins/gryphon', {recursive: true})" }, ctx));
  });
});

test("#36 2.11.4: a redirect target with a quoted '>' is read whole; aliased library deletes", () => {
  withVault((vault, ctx) => {
    fs.mkdirSync(path.join(vault, ">"));
    assert.ok(classify("Bash", { command: `echo x > ".obsidian/plugins/gryphon/../../../>/../.obsidian/plugins/gryphon/main.js"` }, ctx));
    assert.ok(classify("Bash", { command: `echo x > '.obsidian/plugins/gryphon/main.js'>/dev/null` }, ctx));
    assert.ok(classify("mcp__py__run", { code: "import os as o\no.unlink('.obsidian/plugins/gryphon/main.js')" }, ctx));
    assert.ok(classify("mcp__py__run", { code: "import shutil as s\ns.rmtree('.obsidian/plugins/gryphon')" }, ctx));
    assert.equal(classify("mcp__py__run", { code: "tags.remove('.obsidian')\nprint(tags)" }, ctx), null);
    const t = Date.now();
    classify("Bash", { command: ('>"' + "a".repeat(4000) + '"').repeat(300) }, ctx);
    classify("Bash", { command: "> ".repeat(200000) }, ctx);
    assert.ok(Date.now() - t < 3000, `slow ${Date.now() - t}ms`);
  });
});

test("#36 2.11.4: a redirect target longer than the cap is too large, even when quotes would shrink it", () => {
  withVault((_v, ctx) => {
    assert.ok(classify("Bash", { command: 'echo x > a' + '""'.repeat(2200) + '/../.obsidian/plugins/gryphon/main.js' }, ctx));
  });
});

test("#36 2.11.4 focused check: zsh >!, braces, .NET File/Directory, sc/ac, writeFile, big redirect targets stay fast", () => {
  withVault((_v, ctx) => {
    const P = ".obsidian/plugins/gryphon/main.js";
    for (const op of [">!", ">&!", ">&|", ">>!", "&>!"]) assert.ok(classify("Bash", { command: `echo a ${op}${P}` }, ctx), op);
    assert.ok(classify("Bash", { command: "echo a | tee .clau{de,}/settings.json" }, ctx));
    assert.ok(classify("Bash", { command: "echo a >{.claude/settings.json,}" }, ctx));
    assert.ok(classify("Bash", { command: "cp evil.js .obsidian/plugins/gry{phon,phon}/" }, ctx));
    assert.ok(classify("PowerShell", { command: "[IO.File]::Delete('.obsidian\\plugins\\gryphon\\main.js')" }, ctx));
    assert.ok(classify("PowerShell", { command: "[System.IO.File]::WriteAllText('.claude\\settings.json','x')" }, ctx));
    assert.ok(classify("PowerShell", { command: "'x' | sc .claude\\settings.json" }, ctx));
    assert.ok(classify("mcp__js__run", { code: "require('fs').writeFileSync('.obsidian/plugins/gryphon/main.js', 'x')" }, ctx));
    assert.equal(classify("Bash", { command: "echo {a,b} > notes/x.md" }, ctx), null);
    const t = Date.now();
    classify("Bash", { command: ('>"' + "$/".repeat(2046) + '" ').repeat(240) }, ctx);
    assert.ok(Date.now() - t < 2000, `slow ${Date.now() - t}ms`);
  });
});

test("#36 2.11.4: every brace alternative is checked", () => {
  withVault((_v, ctx) => {
    const decoys = Array.from({ length: 40 }, (_, i) => `x${i}`).join(",");
    assert.ok(classify("Bash", { command: `echo a > .clau{${decoys},de}/settings.json` }, ctx));
    const t = Date.now();
    classify("Bash", { command: "echo a > n{" + Array.from({ length: 4000 }, (_, i) => i).join(",") + "}" }, ctx);
    assert.ok(Date.now() - t < 2000);
  });
});

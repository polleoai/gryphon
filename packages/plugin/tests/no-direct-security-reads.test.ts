/**
 * Issue #29 (items 11, 17): no source file reads a weakening key straight
 * off a settings object. Those values come from the vault's data.json, which
 * travels with the vault; enforcement, badges, menus and the settings
 * renderer read the effective snapshot (`effectiveSecuritySettings` /
 * `ctx.security`) instead.
 *
 * Scope: packages/{plugin,protect,provider-runtime}/src. Allowlist: the store
 * module (it owns the data.json comparison and the headless fallback) and
 * any line marked `security-read-ok:` with a reason (the `_migrateSettings`
 * legacy shim, which only ever strengthens).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WEAKENING_KEYS = [
  "protectedMode", "permissionMode", "protectedPathsEnabled", "protectedCommandsEnabled",
  "blockPackageInstall", "protectedPathsDisabled", "protectedCommandsDisabled",
  "claudeCodeInheritUserConfig", "obsidianRestApiPolicy",
];
const KEYS = WEAKENING_KEYS.join("|");
// `settings.permissionMode`, `this.plugin.settings?.protectedMode`,
// `hostPlugin.settings["obsidianRestApiPolicy"]`, `_settings.protectedMode`.
const DIRECT_READ_RE = new RegExp(
  `settings\\s*(?:\\?\\.|\\.)\\s*(?:${KEYS})\\b|settings\\s*(?:\\?\\.)?\\[\\s*["'\`](?:${KEYS})["'\`]\\s*\\]`,
);
const ALLOWLISTED_FILES = new Set([
  "packages/protect/src/security-settings-store.ts",
]);
const MARKER = "security-read-ok:";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCAN_DIRS = ["packages/plugin/src", "packages/protect/src", "packages/provider-runtime/src"];

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(ent.name) && !ent.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Offending `file:line: text` entries for one file's source. */
function scanSource(rel: string, source: string): string[] {
  if (ALLOWLISTED_FILES.has(rel)) return [];
  const hits: string[] = [];
  let inBlockComment = false;
  source.split("\n").forEach((line, i) => {
    let code = line;
    if (inBlockComment) {
      const end = code.indexOf("*/");
      if (end === -1) return;
      code = code.slice(end + 2);
      inBlockComment = false;
    }
    // Block comments as this codebase writes them: opened at line start.
    // (A `/*` mid-line is usually inside a string — a glob like "**/*".)
    if (code.trim().startsWith("/*") && !code.includes("*/")) { inBlockComment = true; return; }
    const trimmed = code.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    code = code.replace(/\/\/.*$/, "");
    if (!DIRECT_READ_RE.test(code)) return;
    if (line.includes(MARKER)) return;
    hits.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
  return hits;
}

test("#29 (11): no direct weakening-key reads in packages/*/src", () => {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, d))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      hits.push(...scanSource(rel, fs.readFileSync(file, "utf8")));
    }
  }
  assert.deepEqual(hits, [], `read these through the security snapshot instead:\n${hits.join("\n")}`);
});

test("#29 (11): the scanner fails on a planted chat-view badge read", () => {
  const real = fs.readFileSync(path.join(ROOT, "packages/plugin/src/chat-view.ts"), "utf8");
  const planted = real + "\nconst m = this.plugin.settings.permissionMode;\n";
  assert.equal(scanSource("packages/plugin/src/chat-view.ts", planted).length, 1);
});

test("#29 (17): the scanner fails on a planted settings-view read", () => {
  const real = fs.readFileSync(path.join(ROOT, "packages/plugin/src/settings-view.ts"), "utf8");
  const planted = real + "\ndrop.setValue(hostPlugin.settings.permissionMode);\n";
  assert.equal(scanSource("packages/plugin/src/settings-view.ts", planted).length, 1);
});

test("#29: the scanner's forms and exemptions", () => {
  const f = "packages/plugin/src/x.ts";
  assert.equal(scanSource(f, "if (plugin?.settings?.protectedMode === false) {}").length, 1);
  assert.equal(scanSource(f, "const p = hostPlugin.settings[\"obsidianRestApiPolicy\"];").length, 1);
  assert.equal(scanSource(f, "const p = _settings.permissionMode;").length, 1);
  assert.equal(scanSource(f, "// settings.permissionMode in a comment").length, 0);
  assert.equal(scanSource(f, " * settings.protectedMode in a doc comment").length, 0);
  assert.equal(scanSource(f, "x = settings.protectedMode; // security-read-ok: shim").length, 0);
  assert.equal(scanSource(f, "const eff = security.permissionMode;").length, 0);
  assert.equal(scanSource("packages/protect/src/security-settings-store.ts", "settings.protectedMode").length, 0);
});

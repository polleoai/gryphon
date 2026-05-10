const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// Workspace move (v1.5.0): this file lives in `packages/plugin/`, but every
// path it touches — esbuild outfile (main.js), HOOK_FILES dest paths, the
// vault-discovery scan, and copyToVault — is naturally rooted at REPO ROOT.
// Downstream consumers vendor this repo as a git submodule and expect
// {main.js, manifest.json, styles.css, hooks/} at the submodule's root,
// and Obsidian loads them from the same root after the build sync. Rather
// than refactor every relative path, we chdir to the repo root once at
// startup and keep the existing semantics. Sources do move (src/ →
// packages/plugin/src/), so the few places we read from `src/` or
// `src/providers/shared/` get rewritten below to `packages/plugin/src/...`.
const REPO_ROOT = path.join(__dirname, "..", "..");
process.chdir(REPO_ROOT);
const PLUGIN_DIR = path.join("packages", "plugin");
const PLUGIN_SRC = path.join(PLUGIN_DIR, "src");
const PROTECT_DIR = path.join("packages", "protect");
const PROTECT_SRC = path.join(PROTECT_DIR, "src");

const watch = process.argv.includes("--watch");

// Hook scripts (v0.6.0). These are plain Node scripts — no external
// deps except `net` / `crypto`, so we copy them into the plugin root
// at build time rather than bundling. Layout under the plugin dir:
//   hooks/pretool.js
//   hooks/posttool.js
//   hooks/...
//   hooks/common/ipc-client.js
// Claude Code invokes these by absolute path (configured via the hook
// settings file the CLI provider writes on each spawn).
const HOOK_FILES = [
  "hooks/pretool.js",
  "hooks/posttool.js",
  "hooks/session-start.js",
  "hooks/session-end.js",
  "hooks/user-prompt.js",
  "hooks/notification.js",
  "hooks/common/ipc-client.js",
  // v0.6.0 Stage 5: posttool.js needs the injection-pattern catalog
  // and the framing builder at hook-invocation time. The source of
  // truth for these modules is `src/providers/shared/` (SDK mode uses
  // the same files), so we copy them into the hook tree at build time
  // rather than forking the source.
  "hooks/common/injection-patterns.js",
  "hooks/common/untrusted-framing.js",
];

// Hook source-of-truth: every hook script (and its helper modules) lives
// under packages/protect/src/. The two `hooks/common/{injection-patterns,
// untrusted-framing}.js` artifacts are the SAME files used by the SDK
// providers — copied at build time rather than duplicated, so the hook
// runtime can load them via plain relative `./common/...` requires.
const HOOK_SOURCE_OVERRIDES = {
  "hooks/common/injection-patterns.js": path.join(PROTECT_SRC, "injection-patterns.js"),
  "hooks/common/untrusted-framing.js": path.join(PROTECT_SRC, "untrusted-framing.js"),
};

// Artifacts Obsidian loads from <vault>/.obsidian/plugins/gryphon/ when the
// plugin is enabled. Keep this list in sync with what `copyToVault` pushes.
const ARTIFACT_FILES = ["main.js", "manifest.json", "styles.css", ...HOOK_FILES];
const PLUGIN_SUBPATH = path.join(".obsidian", "plugins", "gryphon");

// Default sync targets are AUTO-DISCOVERED rather than hardcoded — the
// build script scans known parent directories at build time and finds
// any standalone vault whose `.obsidian/plugins/gryphon/` already
// exists. Consumer projects (those that vendor Gryphon under
// `vendor/gryphon/` and run their own build) are deliberately EXCLUDED
// — they own their plugin-dir contents via their own bundle pipeline,
// and silently overwriting their plugin dir from this build would
// pin them to the dev tree instead of the gryphon release they pinned.
//
// Override or extend with GRYPHON_VAULT (comma- or colon-separated list)
// — those entries get the same install treatment alongside the auto-
// discovered defaults. GRYPHON_NO_DEFAULT_SYNC=1 disables auto-discovery
// entirely (useful in CI).
const HOME = require("os").homedir();

// Parent directories scanned for sibling vaults.
// `~/Documents` catches the canonical "standalone Gryphon test vault".
// `~/Projects` is also scanned for any non-consumer vault, but vaults
// whose root contains a `vendor/gryphon/` are filtered out as consumers.
const DEFAULT_SCAN_PARENTS = [
  path.join(HOME, "Documents"),
  path.join(HOME, "Projects"),
];

/**
 * Discover vault sync targets at build time. Pattern recognized inside
 * each scan-parent directory:
 *
 *   <parent>/<name>/.obsidian/plugins/gryphon/  → vault sync target
 *     (push artifacts into the active plugin folder so reload picks
 *     up new bytes)
 *
 * EXCLUSION: any candidate whose root also contains `vendor/gryphon/`
 * is treated as a consumer project and skipped. Consumer projects own
 * their own bundled-plugin pipeline via a pinned submodule; gryphon's
 * dev build must not write into their plugin dir, or it would override
 * whatever release they've pinned with whatever uncommitted dev state
 * we have right now.
 *
 * The scan is cheap (one readdir per parent + two stats per child) and
 * runs once per build invocation. Returns `{ vaults }`.
 *
 * The current Gryphon repo itself is excluded so we don't sync the
 * build artifacts back over our own source tree.
 */
function discoverSyncTargets() {
  const vaults = [];
  // After v1.5.0 build.js lives at packages/plugin/, NOT repo root.
  // The exclusion below ("don't sync over our own source") needs the
  // actual repo root — REPO_ROOT was computed at module load.
  const repoRoot = REPO_ROOT;
  for (const parent of DEFAULT_SCAN_PARENTS) {
    let entries;
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
    catch (e) {
      // ENOENT (parent dir doesn't exist) is normal — quietly skip.
      // Other errors (EACCES on locked home, EIO on a flaky drive)
      // mask a missed vault sync; surface them so a "build succeeded
      // but nothing landed in the vault" mystery is debuggable.
      if (e && e.code !== "ENOENT") {
        console.warn(`[install] cannot scan ${parent}: ${e.message}`);
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(parent, entry.name);
      // Exclude this repo itself — auto-syncing our own source tree
      // would create a fight between the build output and the git tree.
      if (path.resolve(child) === path.resolve(repoRoot)) continue;
      const vaultPlugin = path.join(child, PLUGIN_SUBPATH);
      if (!fs.existsSync(vaultPlugin)) continue;
      // Consumer-project filter: a vault that ALSO has vendor/gryphon
      // is a consumer project. Its plugin dir is owned by its own
      // build pipeline, not ours.
      const vendorDir = path.join(child, "vendor", "gryphon");
      if (fs.existsSync(vendorDir)) continue;
      vaults.push(child);
    }
  }
  return { vaults };
}

/**
 * Copy src/hooks/ → ./hooks/ alongside main.js so they're shipped as
 * part of the plugin artifacts. Preserves subdirectory structure
 * (common/ipc-client.js) because the hook scripts import it via
 * relative path.
 *
 * Done at build time, not bundle time: bundling each hook with esbuild
 * would drag in several hundred bytes of wrapper code per file. The
 * ipc-client module has zero external deps, so plain copy is simpler
 * and keeps the hook files readable for on-disk inspection.
 */
function syncHooks() {
  for (const artifactRel of HOOK_FILES) {
    // Default source: <PROTECT_SRC>/<artifactRel> — every hook script is
    // owned by the protect package now (Stage 2 of the workspace split).
    const src = HOOK_SOURCE_OVERRIDES[artifactRel]
      || path.join(PROTECT_SRC, artifactRel);
    const dest = artifactRel;   // e.g. "hooks/pretool.js"
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/**
 * Parse GRYPHON_VAULT into an ordered list of vault root paths.
 * Accepts comma- or colon-separated entries so a user with multiple test
 * vaults can push fresh artifacts to all of them on every save:
 *   GRYPHON_VAULT=/path/to/vaultA,/path/to/vaultB npm run dev
 */
function parseVaultList(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw.split(/[,:]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Copy freshly-built artifacts into each vault's plugin folder.
 * Skips vaults whose plugin folder doesn't exist (typo guard — we don't
 * silently create empty plugin dirs that Obsidian would then pick up).
 * Errors are warnings, not fatal: a dev workflow should never halt
 * because one test vault was moved or unmounted.
 */
function copyToVault(vaultPaths, { warnOnMissing = true } = {}) {
  if (vaultPaths.length === 0) return;
  for (const vaultPath of vaultPaths) {
    const dest = path.join(vaultPath, PLUGIN_SUBPATH);
    if (!fs.existsSync(dest)) {
      if (warnOnMissing) {
        console.warn(`[install] Skipping ${vaultPath} — ${dest} not found (enable Gryphon once in Obsidian to create it).`);
      }
      continue;
    }
    let copied = 0;
    for (const file of ARTIFACT_FILES) {
      try {
        const destFile = path.join(dest, file);
        // Subpaths (e.g. "hooks/pretool.js") require the parent dir to
        // exist. mkdirSync with recursive is a no-op if it already does.
        const destFileDir = path.dirname(destFile);
        if (destFileDir !== dest && !fs.existsSync(destFileDir)) {
          fs.mkdirSync(destFileDir, { recursive: true });
        }
        fs.copyFileSync(file, destFile);
        copied += 1;
      } catch (e) {
        console.warn(`[install] Failed to copy ${file} → ${dest}: ${e.message}`);
      }
    }
    if (copied === ARTIFACT_FILES.length) {
      console.log(`[install] → ${dest}`);
    }
  }
}

/**
 * Resolve the final ordered list of vault sync targets:
 *   auto-discovered vaults ∪ GRYPHON_VAULT entries
 * GRYPHON_NO_DEFAULT_SYNC=1 disables auto-discovery — useful in CI or
 * for users who only want their explicit GRYPHON_VAULT to be touched.
 */
function resolveSyncTargets() {
  const userVaults = parseVaultList(process.env.GRYPHON_VAULT);
  const skipDefaults = process.env.GRYPHON_NO_DEFAULT_SYNC === "1";
  const discovered = skipDefaults ? { vaults: [] } : discoverSyncTargets();
  // Order: auto-discovered first, then user-supplied; de-dupe in insertion order.
  const seen = new Set();
  const result = [];
  for (const v of [...discovered.vaults, ...userVaults]) {
    if (seen.has(v)) continue;
    seen.add(v);
    result.push(v);
  }
  return result;
}

// esbuild plugin that syncs artifacts to GRYPHON_VAULT after every successful
// build (one-shot AND watch). Failures inside esbuild don't trigger the
// copy — we'd rather the vault keep its last good build than replace it
// with a broken one.
//
// We also re-sync src/hooks/ → ./hooks/ here so watch mode picks up hook
// edits on the next rebuild (esbuild itself doesn't watch src/hooks/
// because main.js doesn't import them). In practice hooks change rarely,
// and a re-copy of 7 tiny files is imperceptible.
const installToVaultPlugin = {
  name: "install-to-vault",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors && result.errors.length > 0) return;
      try {
        syncHooks();
      } catch (e) {
        console.warn(`[hooks] sync failed: ${e.message}`);
      }
      copyToVault(resolveSyncTargets());
    });
  },
};

const config = {
  entryPoints: [path.resolve(PLUGIN_SRC, "plugin.js")],
  outfile: "main.js",
  absWorkingDir: REPO_ROOT,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2020",
  // Obsidian + Electron provide these at runtime; don't bundle them.
  // `undici` is NOT a Node public built-in — earlier releases marked it
  // external on the (wrong) assumption that require("undici") would
  // resolve inside Obsidian's Electron renderer. It doesn't: plugins
  // ship as a single main.js with no ambient node_modules, so the
  // import crashed the plugin at load time. Bundle it instead — adds
  // ~420 kb but guarantees WebFetch's pinned-DNS Agent is available.
  external: ["obsidian", "electron", "@electron/remote"],
  sourcemap: false,
  // Minify production builds only — non-watch invocations are what users
  // install. Watch mode keeps readable output for stack traces during
  // development. Minification cuts the bundle from ~440kb to ~200kb,
  // mostly by collapsing the @anthropic-ai/sdk's internal layers.
  minify: !watch,
  logLevel: "info",
  plugins: [installToVaultPlugin],
};

async function run() {
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log(`Watching: ${config.entryPoints[0]} → ${config.outfile}`);
    const vaults = resolveSyncTargets();
    if (vaults.length > 0) {
      console.log(`Installing to: ${vaults.map((v) => path.join(v, PLUGIN_SUBPATH)).join(", ")}`);
      console.log("Reload Obsidian (Cmd+R / Ctrl+R) after each change to pick up fresh bytes.");
    } else {
      console.log("No sync targets — set GRYPHON_VAULT or unset GRYPHON_NO_DEFAULT_SYNC to enable.");
    }
  } else {
    const result = await esbuild.build(config);
    const size = fs.statSync(config.outfile).size;
    console.log(`Built ${config.outfile} — ${(size / 1024).toFixed(1)} kb`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

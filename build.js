const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

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

// When a hook artifact has a non-trivial source path, record it here.
// Everything not listed uses `src/<artifactRel>` as its source.
const HOOK_SOURCE_OVERRIDES = {
  "hooks/common/injection-patterns.js": "src/providers/shared/injection-patterns.js",
  "hooks/common/untrusted-framing.js": "src/providers/shared/untrusted-framing.js",
};

// Artifacts Obsidian loads from <vault>/.obsidian/plugins/gryphon/ when the
// plugin is enabled. Keep this list in sync with what `copyToVault` pushes.
const ARTIFACT_FILES = ["main.js", "manifest.json", "styles.css", ...HOOK_FILES];
const PLUGIN_SUBPATH = path.join(".obsidian", "plugins", "gryphon");

// Default sync targets are AUTO-DISCOVERED rather than hardcoded — the
// build script scans known parent directories at build time and finds
// any vault whose `.obsidian/plugins/gryphon/` already exists, plus any
// consumer project that vendors Gryphon at `vendor/gryphon/`. This
// keeps consumer-project names out of tracked source while still giving
// every build a frictionless one-shot sync to wherever the user is
// testing.
//
// Override or extend with GRYPHON_VAULT (comma- or colon-separated list)
// — those entries get the same install treatment alongside the auto-
// discovered defaults. GRYPHON_NO_DEFAULT_SYNC=1 disables auto-discovery
// entirely (useful in CI).
const HOME = require("os").homedir();

// Parent directories scanned for sibling vaults / consumer projects.
// `~/Documents` catches the canonical "standalone Gryphon test vault";
// `~/Projects` catches consumer projects that may vendor Gryphon.
const DEFAULT_SCAN_PARENTS = [
  path.join(HOME, "Documents"),
  path.join(HOME, "Projects"),
];

/**
 * Discover sync targets at build time. Two patterns are recognized
 * inside each scan-parent directory:
 *
 *   1. <parent>/<name>/.obsidian/plugins/gryphon/  → vault sync target
 *      (push artifacts into the active plugin folder so reload picks
 *      up new bytes)
 *
 *   2. <parent>/<name>/vendor/gryphon/             → vendor mirror
 *      (push artifacts into a consumer project's vendored copy so the
 *      consumer's bundled-plugin build sees the latest code without
 *      waiting for a git push to fire the pre-push hook)
 *
 * The scan is cheap (one readdir per parent + a stat per child) and
 * runs once per build invocation. Returns `{ vaults, vendors }`.
 *
 * The current Gryphon repo itself is excluded so we don't sync the
 * build artifacts back over our own source tree.
 */
function discoverSyncTargets() {
  const vaults = [];
  const vendors = [];
  const repoRoot = __dirname; // build.js lives at the gryphon repo root
  for (const parent of DEFAULT_SCAN_PARENTS) {
    let entries;
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(parent, entry.name);
      // Exclude this repo itself — auto-syncing our own source tree
      // would create a fight between the build output and the git tree.
      if (path.resolve(child) === path.resolve(repoRoot)) continue;
      const vaultPlugin = path.join(child, PLUGIN_SUBPATH);
      const vendorDir = path.join(child, "vendor", "gryphon");
      try {
        if (fs.existsSync(vaultPlugin)) vaults.push(child);
      } catch { /* ignore */ }
      try {
        if (fs.existsSync(vendorDir)) vendors.push(vendorDir);
      } catch { /* ignore */ }
    }
  }
  return { vaults, vendors };
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
    const src = HOOK_SOURCE_OVERRIDES[artifactRel]
      || path.join("src", artifactRel);
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
 * Mirror the artifact set into a vendor target (a consumer project's
 * `vendor/gryphon/` directory) so consumers of the vendored tree see
 * the new build immediately, without waiting for the next git push to
 * fire the consumer's vendor-sync hook. We do NOT mirror src/, tests/,
 * or other source-tree directories here — that remains the pre-push
 * hook's job (see CLAUDE.md). The artifact mirror is enough for in-
 * session smoke testing inside the consumer's vault.
 *
 * Skipped silently when the target directory doesn't exist.
 */
function copyToVendor(vendorPaths) {
  if (vendorPaths.length === 0) return;
  for (const vendorPath of vendorPaths) {
    if (!fs.existsSync(vendorPath)) continue;
    let copied = 0;
    for (const file of ARTIFACT_FILES) {
      try {
        const destFile = path.join(vendorPath, file);
        const destFileDir = path.dirname(destFile);
        if (destFileDir !== vendorPath && !fs.existsSync(destFileDir)) {
          fs.mkdirSync(destFileDir, { recursive: true });
        }
        fs.copyFileSync(file, destFile);
        copied += 1;
      } catch (e) {
        console.warn(`[vendor] Failed to copy ${file} → ${vendorPath}: ${e.message}`);
      }
    }
    if (copied === ARTIFACT_FILES.length) {
      console.log(`[vendor] → ${vendorPath}`);
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
  const discovered = skipDefaults ? { vaults: [], vendors: [] } : discoverSyncTargets();
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

function resolveVendorTargets() {
  if (process.env.GRYPHON_NO_DEFAULT_SYNC === "1") return [];
  return discoverSyncTargets().vendors;
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
      copyToVendor(resolveVendorTargets());
    });
  },
};

const config = {
  entryPoints: ["src/plugin.js"],
  outfile: "main.js",
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
      const vendors = resolveVendorTargets();
      if (vendors.length > 0) {
        console.log(`Mirroring to vendor: ${vendors.join(", ")}`);
      }
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

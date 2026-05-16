// back-compat-shims.test.js — pin the v1.5.1 consumer-contract surface.
//
// The shims at gryphon/src/* re-export from the v1.5+ workspace packages.
// Downstream consumers that vendor Gryphon as a git submodule import from
// gryphon/src/* by relative path, e.g. `require("../../vendor/gryphon/src/chat-view")`.
// If a refactor moves the underlying file without updating the shim, this
// test fails BEFORE the broken release ships. (See src/README.md.)
//
// The cause we're guarding against: v1.5.0 moved src/chat-view.js into
// packages/plugin/src/ and shipped without a shim layer. The first
// auto-bump build by a vendor-submodule consumer after the release
// exploded with 7 unresolved imports.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("module");

// chat-view.js eagerly requires "obsidian", which Node can't resolve outside
// the Obsidian app. Other tests in this dir use the same stub-injection trick.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

const REPO_ROOT = path.join(__dirname, "..", "..", "..");

// Each entry pairs (a) the legacy import path the consumer uses with
// (b) the destructured-symbol set the consumer expects to find on it.
// The symbol lists below match the actual destructures used by the
// downstream vendor-submodule consumer — adding to a symbol list here
// is a deliberate contract extension; removing one is a deliberate
// contract break.
const CONTRACT = [
  {
    legacy: "src/chat-view",
    symbols: ["GryphonChatView"],
  },
  {
    legacy: "src/constants",
    symbols: [
      "DEFAULT_SETTINGS",
      "MODELS",
      "EFFORTS",
      "PERMS",
      "PROVIDER_PREFS",
      "resolveConnectionTimeoutMs",
    ],
  },
  {
    legacy: "src/utils",
    symbols: ["findClaudeBinary", "buildEnhancedPath"],
  },
  {
    legacy: "src/skills",
    symbols: ["SkillRegistry"],
  },
  {
    legacy: "src/providers/factory",
    symbols: ["getActiveProviderKind"],
  },
  {
    legacy: "src/providers/google-api/pricing",
    symbols: ["getModelDropdownOptions", "resolveModel", "DEFAULT_MODEL"],
  },
  {
    legacy: "src/providers/openai-api/pricing",
    symbols: ["getModelDropdownOptions", "resolveModel", "DEFAULT_MODEL"],
  },
];

test("every legacy shim file exists at the path consumers import from", () => {
  for (const { legacy } of CONTRACT) {
    const fullPath = path.join(REPO_ROOT, `${legacy}.js`);
    assert.ok(
      fs.existsSync(fullPath),
      `Missing back-compat shim at ${legacy}.js — consumers import from this path. ` +
      `If you moved the underlying file, update or recreate the shim. See src/README.md.`,
    );
  }
});

test("every legacy shim re-exports the symbols downstream consumers destructure", () => {
  for (const { legacy, symbols } of CONTRACT) {
    const mod = require(path.join(REPO_ROOT, legacy));
    for (const symbol of symbols) {
      assert.ok(
        symbol in mod,
        `Shim ${legacy}.js no longer exposes "${symbol}" — vendor-submodule consumers destructure this. ` +
        `Either restore the export at the real package path or coordinate a contract break.`,
      );
      assert.ok(
        mod[symbol] != null,
        `Shim ${legacy}.js exposes "${symbol}" but its value is null/undefined.`,
      );
    }
  }
});

test("shim files contain only a thin re-export (not duplicated logic)", () => {
  // Defensive: catches the failure mode where someone "fixes" a shim by
  // copy-pasting the underlying module's code instead of forwarding to it.
  // Real implementations belong in packages/*/src/, not here.
  for (const { legacy } of CONTRACT) {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, `${legacy}.js`),
      "utf8",
    );
    assert.match(
      src,
      /module\.exports\s*=\s*require\(/,
      `${legacy}.js should be a thin "module.exports = require(...)" shim. ` +
      `Real implementations belong in packages/*/src/.`,
    );
    // Cap shim size so they can't accumulate logic over time.
    assert.ok(
      src.split("\n").length <= 12,
      `${legacy}.js is longer than 12 lines — shims should be tiny re-exports plus a comment header.`,
    );
  }
});

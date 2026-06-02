// Factory wiring + getActiveProviderKind for the new CLI providers
// (codex-cli, gemini-cli). Mirrors the structure of the existing
// factory-openai-google-stubs.test.js but covers the v1.3 surface.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// The factory transitively loads `obsidian` (via anthropic-api's
// permission-gate). Stub it the same way factory-openai-google-stubs.test.js
// does so the tests can run in the bare Node test runner.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

// Stub the binary detectors so tests don't depend on the host system.
const utils = require("../src/utils");
const origCodex = utils.findCodexBinary;
const origGemini = utils.findGeminiBinary;
const origClaude = utils.findClaudeBinary;

function stubBinaries({ codex = null, gemini = null, claude = null }) {
  utils.findCodexBinary = () => codex;
  utils.findGeminiBinary = () => gemini;
  utils.findClaudeBinary = () => claude;
}
function restoreBinaries() {
  utils.findCodexBinary = origCodex;
  utils.findGeminiBinary = origGemini;
  utils.findClaudeBinary = origClaude;
}

// Reset env so process.env.OPENAI_API_KEY etc. don't leak into the
// test (host could have any of these set).
function freshEnv(fn) {
  const snap = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try { fn(); }
  finally { Object.assign(process.env, snap); }
}

// ─────────────────────────────────────────────────────────────────
// createProvider — codex-cli branch
// ─────────────────────────────────────────────────────────────────

test("createProvider returns CodexProvider when preference=codex-cli + binary detected", () => {
  freshEnv(() => {
    stubBinaries({ codex: "/Applications/Codex.app/Contents/Resources/codex" });
    try {
      const { createProvider } = require("../src/factory");
      const { CodexProvider } = require("../src/providers/codex-cli/codex-cli");
      const plugin = { settings: { providerPreference: "codex-cli" } };
      const p = createProvider(plugin, "/tmp/vault");
      assert.ok(p instanceof CodexProvider);
      assert.equal(p.codexPath, "/Applications/Codex.app/Contents/Resources/codex");
    } finally { restoreBinaries(); }
  });
});

test("createProvider returns null when preference=codex-cli + no binary anywhere", () => {
  freshEnv(() => {
    stubBinaries({ codex: null });
    try {
      const { createProvider } = require("../src/factory");
      const plugin = { settings: { providerPreference: "codex-cli" } };
      assert.equal(createProvider(plugin, "/tmp/vault"), null);
    } finally { restoreBinaries(); }
  });
});

test("settings.codexPath overrides autodetect", () => {
  freshEnv(() => {
    stubBinaries({ codex: "/auto/detected/codex" });
    try {
      const { createProvider } = require("../src/factory");
      const { CodexProvider } = require("../src/providers/codex-cli/codex-cli");
      const plugin = {
        settings: {
          providerPreference: "codex-cli",
          codexPath: "/manual/path/codex",
        },
      };
      const p = createProvider(plugin, "/tmp/vault");
      assert.ok(p instanceof CodexProvider);
      assert.equal(p.codexPath, "/manual/path/codex");
    } finally { restoreBinaries(); }
  });
});

// ─────────────────────────────────────────────────────────────────
// createProvider — gemini-cli branch
// ─────────────────────────────────────────────────────────────────

test("createProvider returns GeminiCliProvider when preference=gemini-cli + binary detected", () => {
  freshEnv(() => {
    stubBinaries({ gemini: "/opt/homebrew/bin/gemini" });
    try {
      const { createProvider } = require("../src/factory");
      const { GeminiCliProvider } = require("../src/providers/gemini-cli/gemini-cli");
      const plugin = { settings: { providerPreference: "gemini-cli" } };
      const p = createProvider(plugin, "/tmp/vault");
      assert.ok(p instanceof GeminiCliProvider);
      assert.equal(p.geminiPath, "/opt/homebrew/bin/gemini");
    } finally { restoreBinaries(); }
  });
});

test("createProvider returns null when preference=gemini-cli + no binary anywhere", () => {
  freshEnv(() => {
    stubBinaries({ gemini: null });
    try {
      const { createProvider } = require("../src/factory");
      const plugin = { settings: { providerPreference: "gemini-cli" } };
      assert.equal(createProvider(plugin, "/tmp/vault"), null);
    } finally { restoreBinaries(); }
  });
});

test("settings.geminiCliPath overrides autodetect", () => {
  freshEnv(() => {
    stubBinaries({ gemini: "/auto/gemini" });
    try {
      const { createProvider } = require("../src/factory");
      const { GeminiCliProvider } = require("../src/providers/gemini-cli/gemini-cli");
      const plugin = {
        settings: {
          providerPreference: "gemini-cli",
          geminiCliPath: "/manual/gemini",
        },
      };
      const p = createProvider(plugin, "/tmp/vault");
      assert.ok(p instanceof GeminiCliProvider);
      assert.equal(p.geminiPath, "/manual/gemini");
    } finally { restoreBinaries(); }
  });
});

// ─────────────────────────────────────────────────────────────────
// auto-mode does NOT pick up CLI fallthroughs (intentional —
// they need explicit opt-in)
// ─────────────────────────────────────────────────────────────────

test("auto preference does NOT select codex-cli even when only Codex is available", () => {
  freshEnv(() => {
    stubBinaries({
      codex: "/Applications/Codex.app/Contents/Resources/codex",
      gemini: null, claude: null,
    });
    try {
      const { createProvider } = require("../src/factory");
      const plugin = { settings: { providerPreference: "auto" } };
      // No API keys, no claude binary, only codex → null. Auto refuses
      // to silently route to codex because of UX surprise (sandbox prompts).
      assert.equal(createProvider(plugin, "/tmp"), null);
    } finally { restoreBinaries(); }
  });
});

test("auto preference does NOT select gemini-cli even when only Gemini is available", () => {
  freshEnv(() => {
    stubBinaries({ gemini: "/opt/homebrew/bin/gemini", claude: null });
    try {
      const { createProvider } = require("../src/factory");
      const plugin = { settings: { providerPreference: "auto" } };
      assert.equal(createProvider(plugin, "/tmp"), null);
    } finally { restoreBinaries(); }
  });
});

// ─────────────────────────────────────────────────────────────────
// getActiveProviderKind
// ─────────────────────────────────────────────────────────────────

test("getActiveProviderKind returns codex-cli when preference=codex-cli + binary present", () => {
  freshEnv(() => {
    stubBinaries({ codex: "/Applications/Codex.app/Contents/Resources/codex" });
    try {
      const { getActiveProviderKind } = require("../src/factory");
      const plugin = { settings: { providerPreference: "codex-cli" } };
      assert.equal(getActiveProviderKind(plugin), "codex-cli");
    } finally { restoreBinaries(); }
  });
});

test("getActiveProviderKind returns null when preference=codex-cli + binary missing", () => {
  freshEnv(() => {
    stubBinaries({ codex: null });
    try {
      const { getActiveProviderKind } = require("../src/factory");
      const plugin = { settings: { providerPreference: "codex-cli" } };
      assert.equal(getActiveProviderKind(plugin), null);
    } finally { restoreBinaries(); }
  });
});

test("getActiveProviderKind returns gemini-cli when preference=gemini-cli + binary present", () => {
  freshEnv(() => {
    stubBinaries({ gemini: "/opt/homebrew/bin/gemini" });
    try {
      const { getActiveProviderKind } = require("../src/factory");
      const plugin = { settings: { providerPreference: "gemini-cli" } };
      assert.equal(getActiveProviderKind(plugin), "gemini-cli");
    } finally { restoreBinaries(); }
  });
});

// ─────────────────────────────────────────────────────────────────
// explainUnavailable
// ─────────────────────────────────────────────────────────────────

test("explainUnavailable for codex-cli + no binary points to install steps", () => {
  freshEnv(() => {
    stubBinaries({ codex: null });
    try {
      const { explainUnavailable } = require("../src/factory");
      const plugin = { settings: { providerPreference: "codex-cli" } };
      const msg = explainUnavailable(plugin);
      assert.match(msg, /codex/i);
      assert.match(msg, /chatgpt\.com\/codex|Codex CLI path/i);
    } finally { restoreBinaries(); }
  });
});

test("explainUnavailable for gemini-cli + no binary mentions npm install", () => {
  freshEnv(() => {
    stubBinaries({ gemini: null });
    try {
      const { explainUnavailable } = require("../src/factory");
      const plugin = { settings: { providerPreference: "gemini-cli" } };
      const msg = explainUnavailable(plugin);
      assert.match(msg, /gemini/i);
      assert.match(msg, /npm install/i);
    } finally { restoreBinaries(); }
  });
});

// ─────────────────────────────────────────────────────────────────
// detectAvailable surface
// ─────────────────────────────────────────────────────────────────

test("detectAvailable surfaces codexPath and geminiCliPath alongside SDK keys", () => {
  freshEnv(() => {
    stubBinaries({
      codex: "/Applications/Codex.app/Contents/Resources/codex",
      gemini: "/opt/homebrew/bin/gemini",
    });
    try {
      const { detectAvailable } = require("../src/factory");
      const plugin = { settings: {} };
      const avail = detectAvailable(plugin);
      assert.equal(avail.codexPath, "/Applications/Codex.app/Contents/Resources/codex");
      assert.equal(avail.geminiCliPath, "/opt/homebrew/bin/gemini");
    } finally { restoreBinaries(); }
  });
});

// ─────────────────────────────────────────────────────────────────
// DEFAULT_SETTINGS includes the new path keys
// ─────────────────────────────────────────────────────────────────

test("DEFAULT_SETTINGS includes codexPath and geminiCliPath as empty strings", () => {
  const { DEFAULT_SETTINGS } = require("../../plugin/src/constants");
  assert.equal(DEFAULT_SETTINGS.codexPath, "");
  assert.equal(DEFAULT_SETTINGS.geminiCliPath, "");
});

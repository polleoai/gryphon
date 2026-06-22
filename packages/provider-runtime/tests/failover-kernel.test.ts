/**
 * Issue #15 — fallback provider/model with automatic failover.
 *
 * The reusable kernel exported from @gryphon/provider-runtime:
 *   - classifyProviderFailure(errOrNull) → { kind, reason }
 *   - resolveFallback(plugin) → { kind, model } | null
 *   - createProviderForKind(plugin, kind, cwd, options, modelOverride?) → LLMProvider|null
 *
 * These three are the consumer-facing contract (Athena drives the provider
 * layer from BOTH its embedded chat view AND its synthesis/page-production
 * path). The kernel must be pure over (plugin, err) with zero chat-view
 * dependency, and all three must be reachable from the package index.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// The factory transitively loads `obsidian` (via anthropic-api's
// permission-gate). Stub it the same way the other factory tests do.
const stubPath = require.resolve("./_stubs/obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...args);
};

// Stub binary detectors so tests don't depend on the host system.
const utils = require("../src/utils");
const origCodex = utils.findCodexBinary;
const origGemini = utils.findGeminiBinary;
const origClaude = utils.findClaudeBinary;
function stubBinaries({ codex = null, gemini = null, claude = null } = {}) {
  utils.findCodexBinary = () => codex;
  utils.findGeminiBinary = () => gemini;
  utils.findClaudeBinary = () => claude;
}
function restoreBinaries() {
  utils.findCodexBinary = origCodex;
  utils.findGeminiBinary = origGemini;
  utils.findClaudeBinary = origClaude;
}
function freshEnv(fn) {
  const snap = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try { return fn(); }
  finally { Object.assign(process.env, snap); }
}

const runtime = require("../src/index");
const { classifyProviderFailure, resolveFallback, createProviderForKind } = runtime;

// ── kernel reachable from the package index (Athena contract) ─────────

test("issue #15: all three kernel fns exported from index", () => {
  assert.equal(typeof classifyProviderFailure, "function");
  assert.equal(typeof resolveFallback, "function");
  assert.equal(typeof createProviderForKind, "function");
});

// ── classifyProviderFailure ───────────────────────────────────────────

test("issue #15: null (construct-time) → availability / construct-null", () => {
  assert.deepEqual(classifyProviderFailure(null), {
    kind: "availability",
    reason: "construct-null",
  });
  assert.deepEqual(classifyProviderFailure(undefined), {
    kind: "availability",
    reason: "construct-null",
  });
});

test("issue #15: anthropic-api missing key → no-api-key (availability)", () => {
  const err = new Error(
    "Could not resolve authentication method. Expected either apiKey or " +
    "authToken to be set.",
  );
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "no-api-key");
});

test("issue #15: anthropic-api 401 invalid key → auth (availability)", () => {
  const err = Object.assign(new Error("invalid x-api-key"), { status: 401 });
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "auth");
});

test("issue #15: anthropic-api credit balance → insufficient-credit", () => {
  const err = Object.assign(
    new Error("Your credit balance is too low to access the Anthropic API."),
    { status: 400 },
  );
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "insufficient-credit");
});

test("issue #15: openai-api missing key env var → no-api-key", () => {
  const err = new Error(
    "The OPENAI_API_KEY environment variable is missing or empty.",
  );
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "no-api-key");
});

test("issue #15: openai-api insufficient_quota (429) → insufficient-credit (not rate-limit)", () => {
  // OpenAI surfaces an out-of-credit account as HTTP 429 with code
  // "insufficient_quota" — it is a billing failure, not a transient cap.
  const err = Object.assign(
    new Error("You exceeded your current quota, please check your plan and billing details."),
    { status: 429, code: "insufficient_quota" },
  );
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "insufficient-credit");
});

test("issue #15: openai-api 429 Too Many Requests → rate-limit", () => {
  const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "rate-limit");
});

test("issue #15: google-api RESOURCE_EXHAUSTED → rate-limit (availability)", () => {
  const err = new Error("[429 Too Many Requests] RESOURCE_EXHAUSTED");
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "rate-limit");
});

test("issue #15: google-api invalid key (nested error.status 403) → auth", () => {
  const err = { message: "API key not valid. Please pass a valid API key.", error: { status: 403 } };
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "auth");
});

test("issue #15: claude-code CLI stderr rate limit → rate-limit", () => {
  const err = new Error("Claude AI usage limit reached; please retry in 30s");
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "rate-limit");
});

test("issue #15: codex-cli stderr 401 Unauthorized → auth", () => {
  const err = new Error("codex: request failed: 401 Unauthorized");
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "auth");
});

test("issue #15: gemini-cli stderr quota exhausted → quota", () => {
  const err = new Error("gemini: quota exhausted for the day");
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "availability");
  assert.equal(c.reason, "quota");
});

test("issue #15: genuine content/runtime errors are NOT availability", () => {
  // A working provider that throws a content/runtime error must NOT fail over.
  const content = classifyProviderFailure(new Error("model returned no parseable JSON"));
  assert.notEqual(content.kind, "availability");
  assert.equal(content.reason, null);

  const runtime = classifyProviderFailure(new Error("Connection timed out after 60s"));
  assert.notEqual(runtime.kind, "availability");
  assert.equal(runtime.reason, null);

  const server = classifyProviderFailure(Object.assign(new Error("Server error"), { status: 500 }));
  assert.notEqual(server.kind, "availability");
});

test("issue #15: CliStructuredOutputError classifies as content", () => {
  const { CliStructuredOutputError } = runtime;
  const err = new CliStructuredOutputError("schema validation failed", { reason: "invalid-json" });
  const c = classifyProviderFailure(err);
  assert.equal(c.kind, "content");
  assert.equal(c.reason, null);
});

// ── resolveFallback ───────────────────────────────────────────────────

test("issue #15: resolveFallback returns null when preference is 'none'", () => {
  freshEnv(() => {
    stubBinaries({ claude: "/usr/bin/claude" });
    try {
      const plugin = { settings: { fallbackProviderPreference: "none" } };
      assert.equal(resolveFallback(plugin), null);
    } finally { restoreBinaries(); }
  });
});

test("issue #15: resolveFallback default (unset) → claude-code iff binary detected", () => {
  freshEnv(() => {
    stubBinaries({ claude: "/usr/bin/claude" });
    try {
      const plugin = { settings: {} };
      const fb = resolveFallback(plugin);
      assert.equal(fb.kind, "claude-code");
      assert.ok(fb.model, "model should default to the anthropic registry default");
    } finally { restoreBinaries(); }
  });
});

test("issue #15: resolveFallback default (unset) → null when no claude binary", () => {
  freshEnv(() => {
    stubBinaries({}); // nothing detected
    try {
      const plugin = { settings: {} };
      assert.equal(resolveFallback(plugin), null);
    } finally { restoreBinaries(); }
  });
});

test("issue #15: resolveFallback explicit kind + explicit model", () => {
  freshEnv(() => {
    stubBinaries({});
    try {
      const plugin = {
        settings: {
          fallbackProviderPreference: "anthropic-api",
          fallbackModel: "claude-opus-4-8",
        },
      };
      assert.deepEqual(resolveFallback(plugin), {
        kind: "anthropic-api",
        model: "claude-opus-4-8",
      });
    } finally { restoreBinaries(); }
  });
});

test("issue #15: resolveFallback explicit kind, empty model → registry default", () => {
  freshEnv(() => {
    stubBinaries({});
    try {
      const plugin = { settings: { fallbackProviderPreference: "google-api", fallbackModel: "" } };
      const fb = resolveFallback(plugin);
      assert.equal(fb.kind, "google-api");
      assert.ok(fb.model && fb.model.length > 0, "should fall back to google registry default");
    } finally { restoreBinaries(); }
  });
});

test("issue #15: resolveFallback 'auto' → first available (claude-code when only claude present)", () => {
  freshEnv(() => {
    stubBinaries({ claude: "/usr/bin/claude" });
    try {
      const plugin = { settings: { fallbackProviderPreference: "auto" } };
      const fb = resolveFallback(plugin);
      assert.equal(fb.kind, "claude-code");
    } finally { restoreBinaries(); }
  });
});

// ── createProviderForKind ─────────────────────────────────────────────

test("issue #15: createProviderForKind builds an EXPLICIT kind, ignoring providerPreference", () => {
  freshEnv(() => {
    stubBinaries({ claude: "/usr/bin/claude" });
    try {
      // providerPreference says google-api, but we explicitly ask for claude-code.
      const plugin = { settings: { providerPreference: "google-api", claudePath: "/usr/bin/claude" } };
      const { ClaudeCodeProvider } = require("../src/providers/claude-code/claude-code");
      const p = createProviderForKind(plugin, "claude-code", "/tmp/vault", {});
      assert.ok(p instanceof ClaudeCodeProvider);
    } finally { restoreBinaries(); }
  });
});

test("issue #15: createProviderForKind returns null when the kind has no key/CLI", () => {
  freshEnv(() => {
    stubBinaries({});
    try {
      const plugin = { settings: {} };
      assert.equal(createProviderForKind(plugin, "anthropic-api", "/tmp/vault", {}), null);
      assert.equal(createProviderForKind(plugin, "google-api", "/tmp/vault", {}), null);
      assert.equal(createProviderForKind(plugin, "claude-code", "/tmp/vault", {}), null);
    } finally { restoreBinaries(); }
  });
});

test("issue #15: createProviderForKind honors modelOverride", () => {
  freshEnv(() => {
    stubBinaries({});
    try {
      const plugin = { settings: { anthropicApiKey: "sk-test" } };
      const { AnthropicAPIProvider } = require("../src/providers/anthropic-api/anthropic-api");
      const p = createProviderForKind(plugin, "anthropic-api", "/tmp/vault", {}, "claude-opus-4-8");
      assert.ok(p instanceof AnthropicAPIProvider);
      // The override should reach the provider's resolved model surface.
      assert.equal(p.resolvedModel, "claude-opus-4-8");
    } finally { restoreBinaries(); }
  });
});

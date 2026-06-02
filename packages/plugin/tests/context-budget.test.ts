/**
 * v1.7.0 F1 — context-budget estimator unit tests.
 *
 * Coverage:
 *   - chars→tokens + bytes→tokens heuristic shape
 *   - escapeVaultPath round-trip semantics (matches CC's "absolute path
 *     with / → -" transformation)
 *   - collectContextSources against a fixture directory tree
 *   - summarizeContext math (totals, percent, overflow flag)
 *   - calibration delta application
 *   - measured-history-tokens override
 *   - SDK vs CLI baseline divergence
 *
 * What is NOT covered here (lives in higher-level chat-view tests):
 *   - debouncing of the keyup handler
 *   - chip render
 *   - send-button gating
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  collectContextSources,
  summarizeContext,
  estimateTokensFromChars,
  estimateTokensFromBytes,
  escapeVaultPath,
  CC_SYSTEM_PROMPT_TOKENS_BASELINE,
  CC_TOOL_SCHEMAS_TOKENS_BASELINE,
  SDK_SYSTEM_PROMPT_TOKENS_BASELINE,
  SDK_TOOL_SCHEMAS_TOKENS_BASELINE,
} = require("../src/context-budget");

// ── helpers ───────────────────────────────────────────────────────────

function mkTempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-ctx-vault-"));
  // Clean up at process exit — node:test doesn't expose per-test teardown
  // for file fixtures so we just let the OS reap on exit.
  return dir;
}

function mkTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gryphon-ctx-home-"));
  return dir;
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ── estimateTokensFromChars ───────────────────────────────────────────

test("estimateTokensFromChars: ASCII text uses 0.25 chars/token", () => {
  assert.equal(estimateTokensFromChars("0123"), 1);       // 4 chars → 1 token
  assert.equal(estimateTokensFromChars("01234567"), 2);   // 8 chars → 2 tokens
  assert.equal(estimateTokensFromChars(""), 0);
});

test("estimateTokensFromChars: non-string inputs return 0 (defensive)", () => {
  assert.equal(estimateTokensFromChars(null), 0);
  assert.equal(estimateTokensFromChars(undefined), 0);
  assert.equal(estimateTokensFromChars(42), 0);
  assert.equal(estimateTokensFromChars({}), 0);
});

test("estimateTokensFromBytes: round-trips with estimateTokensFromChars for ASCII", () => {
  // 100 bytes of ASCII = 100 chars → 25 tokens
  assert.equal(estimateTokensFromBytes(100), 25);
});

test("estimateTokensFromBytes: non-positive / non-number inputs return 0", () => {
  assert.equal(estimateTokensFromBytes(0), 0);
  assert.equal(estimateTokensFromBytes(-50), 0);
  assert.equal(estimateTokensFromBytes(null), 0);
  assert.equal(estimateTokensFromBytes(NaN), 0);
});

// ── escapeVaultPath ───────────────────────────────────────────────────

test("escapeVaultPath: macOS/Linux absolute path → CC's escaped form", () => {
  // CC writes auto-memory at ~/.claude/projects/<escaped>/memory/ where
  // the escape rule is "replace every / with -". Verify the exact
  // transformation so the memory-dir lookup hits the right path.
  assert.equal(escapeVaultPath("/Users/test/projects/gryphon"),
    "-Users-test-projects-gryphon");
});

test("escapeVaultPath: Windows backslash separators normalize to forward first", () => {
  // CC normalizes path separators before escaping. We mirror that so a
  // Windows vault path produces the same dir name CC's own writer used.
  assert.equal(escapeVaultPath("C:\\Users\\foo\\vault"),
    "C:-Users-foo-vault");
});

test("escapeVaultPath: empty / non-string inputs return empty string", () => {
  assert.equal(escapeVaultPath(""), "");
  assert.equal(escapeVaultPath(null), "");
  assert.equal(escapeVaultPath(undefined), "");
});

// ── collectContextSources ─────────────────────────────────────────────

test("collectContextSources: claude-code mode loads CC baselines + CLAUDE.md hierarchy", async () => {
  const home = mkTempHome();
  const vault = mkTempVault();
  // 1000-char CLAUDE.md → 250 tokens estimate (rounded up).
  writeFile(path.join(home, ".claude", "CLAUDE.md"), "x".repeat(1000));
  writeFile(path.join(home, "CLAUDE.md"), "y".repeat(2000));   // 500 tokens
  writeFile(path.join(vault, "CLAUDE.md"), "z".repeat(4000));  // 1000 tokens
  writeFile(path.join(vault, "AGENTS.md"), "w".repeat(800));   // 200 tokens

  const snap = await collectContextSources({
    kind: "claude-code",
    vaultPath: vault,
    homeDir: home,
  });

  assert.equal(snap.ccSystemPromptTokens, CC_SYSTEM_PROMPT_TOKENS_BASELINE);
  assert.equal(snap.toolSchemaTokens, CC_TOOL_SCHEMAS_TOKENS_BASELINE);
  assert.equal(snap.userClaudeMdTokens, 250);
  assert.equal(snap.homeClaudeMdTokens, 500);
  assert.equal(snap.vaultClaudeMdTokens, 1000);
  assert.equal(snap.vaultAgentsMdTokens, 200);
  assert.equal(snap.memoryMdTokens, 0);    // no memory dir created in this fixture
  assert.equal(snap.memoryDirTokens, 0);
});

test("collectContextSources: missing CLAUDE.md files yield 0 (no throw)", async () => {
  const home = mkTempHome();   // empty
  const vault = mkTempVault(); // empty
  const snap = await collectContextSources({
    kind: "claude-code",
    vaultPath: vault,
    homeDir: home,
  });
  assert.equal(snap.userClaudeMdTokens, 0);
  assert.equal(snap.vaultClaudeMdTokens, 0);
  assert.equal(snap.vaultAgentsMdTokens, 0);
  assert.equal(snap.memoryFileCount, 0);
});

test("collectContextSources: auto-memory dir is summed + MEMORY.md is capped at 24KB", async () => {
  const home = mkTempHome();
  const vault = mkTempVault();
  const escaped = vault.replace(/\\/g, "/").replace(/\//g, "-");
  const memDir = path.join(home, ".claude", "projects", escaped, "memory");
  // 40KB MEMORY.md — CC effectively reads only 24KB (its hard cap).
  writeFile(path.join(memDir, "MEMORY.md"), "m".repeat(40 * 1024));
  // Two sibling memory files — counted toward the worst-case dir total.
  writeFile(path.join(memDir, "session-foo.md"), "f".repeat(8 * 1024));   // 8K
  writeFile(path.join(memDir, "session-bar.md"), "b".repeat(4 * 1024));   // 4K

  const snap = await collectContextSources({
    kind: "claude-code",
    vaultPath: vault,
    homeDir: home,
  });

  // 24KB cap → 24576 bytes * 0.25 = 6144 tokens
  assert.equal(snap.memoryMdTokens, 6144);
  // Worst case dir = 40KB MEMORY.md + 8K + 4K = 52KB → 13312 tokens raw,
  // minus the MEMORY.md portion (10240 raw → 2560 effective after the
  // 24KB cap) = the "other files" delta. We assert >0 and bounded above.
  assert.ok(snap.memoryDirTokens > 0, "worst-case dir total should be positive");
  assert.ok(snap.memoryDirTokens < 20000, "worst-case dir total bounded");
  assert.equal(snap.memoryFileCount, 2);  // session-foo + session-bar
});

test("collectContextSources: SDK mode uses smaller baselines + no auto-memory", async () => {
  const home = mkTempHome();
  const vault = mkTempVault();
  // Create a memory dir that WOULD be read in claude-code mode; in SDK
  // mode it should be ignored entirely.
  const escaped = vault.replace(/\\/g, "/").replace(/\//g, "-");
  writeFile(
    path.join(home, ".claude", "projects", escaped, "memory", "MEMORY.md"),
    "should-not-be-counted-in-sdk-mode"
  );

  const snap = await collectContextSources({
    kind: "anthropic-api",
    vaultPath: vault,
    homeDir: home,
  });

  assert.equal(snap.ccSystemPromptTokens, SDK_SYSTEM_PROMPT_TOKENS_BASELINE);
  assert.equal(snap.toolSchemaTokens, SDK_TOOL_SCHEMAS_TOKENS_BASELINE);
  assert.equal(snap.memoryMdTokens, 0,
    "SDK mode must not count CC's auto-memory");
  assert.equal(snap.memoryDirTokens, 0);
});

// ── summarizeContext ──────────────────────────────────────────────────

test("summarizeContext: totalTokens is the sum of bySource + history + input", () => {
  const sources = {
    ccSystemPromptTokens: 1500,
    toolSchemaTokens: 2500,
    userClaudeMdTokens: 100,
    homeClaudeMdTokens: 100,
    vaultClaudeMdTokens: 500,
    vaultAgentsMdTokens: 0,
    memoryMdTokens: 6000,
    memoryDirTokens: 2000,
  };
  const out = summarizeContext({
    sources,
    messages: [],
    userInput: "0123",  // 1 token
    windowSize: 1_000_000,
  });
  // 1500 + 2500 + 100 + 100 + 500 + 0 + 6000 + 2000 + 0 (history) + 1 (input)
  assert.equal(out.totalTokens, 12701);
  assert.equal(out.windowSize, 1_000_000);
  assert.equal(out.pct, 1);       // ~1% of 1M
  assert.equal(out.likelyOverflow, false);
});

test("summarizeContext: chatHistory estimated from message text when no measured value provided", () => {
  const out = summarizeContext({
    sources: { ccSystemPromptTokens: 0, toolSchemaTokens: 0 },
    messages: [{ text: "0123" }, { text: "456789ab" }],  // 1 + 2 = 3 tokens
    userInput: "",
    windowSize: 200000,
  });
  assert.equal(out.bySource.chatHistoryTokens, 3);
  assert.equal(out.totalTokens, 3);
});

test("summarizeContext: measuredHistoryTokens overrides the estimate", () => {
  const out = summarizeContext({
    sources: {},
    messages: [{ text: "x".repeat(1000) }],  // would estimate to 250 if used
    userInput: "",
    windowSize: 200000,
    measuredHistoryTokens: 50000,            // ground truth from prior turn
  });
  assert.equal(out.bySource.chatHistoryTokens, 50000);
});

test("summarizeContext: pct caps at 100 but rawPct exposes overshoot for the popover", () => {
  const out = summarizeContext({
    sources: { ccSystemPromptTokens: 250000 },
    messages: [],
    userInput: "",
    windowSize: 200000,
  });
  assert.equal(out.pct, 100);
  assert.equal(out.rawPct, 125);
  assert.equal(out.likelyOverflow, true);
});

test("summarizeContext: likelyOverflow fires at >95% of window", () => {
  const just95 = summarizeContext({
    sources: { ccSystemPromptTokens: 190000 },
    messages: [],
    userInput: "",
    windowSize: 200000,
  });
  // 190000 / 200000 = 95.0% — NOT yet overflow (strictly greater)
  assert.equal(just95.likelyOverflow, false);

  const over95 = summarizeContext({
    sources: { ccSystemPromptTokens: 190001 },
    messages: [],
    userInput: "",
    windowSize: 200000,
  });
  assert.equal(over95.likelyOverflow, true);
});

test("summarizeContext: calibrationDelta is added on top of the raw sum", () => {
  const sources = { ccSystemPromptTokens: 1000 };
  const baseline = summarizeContext({
    sources, messages: [], userInput: "", windowSize: 1_000_000,
  });
  const calibrated = summarizeContext({
    sources, messages: [], userInput: "", windowSize: 1_000_000,
    calibrationDelta: 500,
  });
  assert.equal(calibrated.totalTokens, baseline.totalTokens + 500);
});

test("summarizeContext: invalid windowSize falls back to 200K (safe default)", () => {
  const out = summarizeContext({
    sources: { ccSystemPromptTokens: 1000 },
    messages: [], userInput: "",
    windowSize: undefined,
  });
  assert.equal(out.windowSize, 200000);
});

test("summarizeContext: invalid calibrationDelta is ignored (non-finite)", () => {
  const sources = { ccSystemPromptTokens: 1000 };
  const out = summarizeContext({
    sources, messages: [], userInput: "", windowSize: 200000,
    calibrationDelta: NaN,
  });
  assert.equal(out.totalTokens, 1000);
});

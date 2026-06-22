/**
 * Context budget estimator (v1.7.0 F1).
 *
 * Two functions, separated by cost profile:
 *
 *   collectContextSources({...})    — async, filesystem I/O, called once
 *                                     per session-state change (model change,
 *                                     /new, /clear, model selection toggle).
 *
 *   summarizeContext({...})         — pure, no I/O, called on every input
 *                                     keystroke (debounced) to update the
 *                                     projection chip.
 *
 * The split keeps the per-keystroke path cheap while still letting the chip
 * reflect the cumulative system-prompt cost (which doesn't change between
 * spawns and shouldn't be re-stat'd on every keyup).
 *
 * Why we estimate at all: `claudeProcess.contextTokens` is only set AFTER
 * the LLM reports usage back. Fresh sessions, overflow failures, and the
 * first message of a session all show 0% in the meter even when the actual
 * prompt is huge. The estimator gives the user a meaningful number from
 * message #1, plus a per-source breakdown so they know which lever to pull.
 *
 * Accuracy goal: within ~15% of the post-turn measured tokens for CLI mode
 * (heuristic), exact for SDK mode (countTokens). Self-tuning calibration
 * (Stage D) sharpens this over time.
 */

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const os = require("os") as typeof import("os");

// 1 token ≈ 4 chars is the rough rule-of-thumb for English text against
// the Claude tokenizer. Code and JSON are more dense (~3 chars/token);
// natural language is less dense (~5 chars/token). 0.25 is the median
// that splits the error symmetrically. Self-tuning calibration learns
// the per-vault deviation from this baseline.
const CHARS_PER_TOKEN = 0.25;

// Fixed baselines for inputs we can't directly measure. Calibrated by
// counting Anthropic's published prompts + sampling CC spawn args. These
// are the v1.7.0 starting points; the rolling-average calibrator
// (Stage D) layers a per-vault delta on top.
const CC_SYSTEM_PROMPT_TOKENS_BASELINE = 1500;   // CC's built-in system prompt
const CC_TOOL_SCHEMAS_TOKENS_BASELINE = 2500;    // CC's built-in tool definitions
const MCP_SERVER_TOKENS_BASELINE = 1500;         // per registered MCP server

// SDK-mode (anthropic-api) has a different baseline because Gryphon
// owns the system prompt + tool list, not CC.
const SDK_SYSTEM_PROMPT_TOKENS_BASELINE = 300;   // Gryphon's appended hint is small
const SDK_TOOL_SCHEMAS_TOKENS_BASELINE = 800;    // smaller tool set than CC

/**
 * Approximate token count of a UTF-8 string using the chars/4 heuristic.
 * Centralized so calibration can slot a multiplier in one place later.
 */
function estimateTokensFromChars(text) {
  if (typeof text !== "string") return 0;
  return Math.ceil(text.length * CHARS_PER_TOKEN);
}

/**
 * Approximate token count from a byte size (assumes UTF-8, ~1 byte per
 * char for ASCII-dominated content like CLAUDE.md / source files).
 */
function estimateTokensFromBytes(bytes) {
  // Explicit `Number.isFinite` check is required because `NaN <= 0` is
  // false — without it, `Math.ceil(NaN * 0.25)` falls through and returns
  // NaN, which then poisons every downstream sum.
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes * CHARS_PER_TOKEN);
}

/**
 * stat a file path and return its size in bytes, 0 if missing.
 * Used for the CLAUDE.md hierarchy + memory dir scans. Catches every
 * error (ENOENT, EACCES, EISDIR) and returns 0 — the estimator should
 * never throw, just under-report.
 */
function safeStatBytes(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    if (st.isDirectory()) return 0;  // caller handles dirs explicitly
    return 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Sum the byte sizes of every `*.md` file directly inside a directory
 * (non-recursive — CC's auto-loader doesn't descend). Returns 0 if the
 * dir is missing.
 *
 * Worst-case estimate for auto-memory: CC reads MEMORY.md first
 * (capped at 24KB) and then on-demand pulls per @link references.
 * Summing ALL `*.md` files over-counts because not all get loaded per
 * turn. We report this as worst-case in the breakdown so the user
 * understands the upper bound.
 */
function sumDirMarkdownBytes(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      total += safeStatBytes(path.join(dirPath, entry.name));
    }
    return total;
  } catch (_) {
    return 0;
  }
}

/**
 * Convert the vault's absolute path to CC's "escaped" project directory
 * name. CC writes auto-memory under
 *   ~/.claude/projects/<escapedAbsPath>/memory/
 * where `escapedAbsPath` is the absolute path with every `/` replaced by
 * `-`. Mirror that transformation here so we can locate the memory dir
 * without spawning CC.
 *
 * Cross-platform note: on Windows, paths use `\\` and a drive letter
 * (`C:\\Users\\foo\\vault`). CC normalizes Windows paths to forward
 * slashes before escaping, so we do the same here.
 */
function escapeVaultPath(absVaultPath) {
  if (typeof absVaultPath !== "string" || !absVaultPath) return "";
  // Normalize Windows separators to forward slashes, then replace all `/`.
  // The Windows drive letter becomes part of the dir name as-is.
  return absVaultPath.replace(/\\/g, "/").replace(/\//g, "-");
}

/**
 * Snapshot the filesystem inputs that contribute to the model's context
 * budget. Async because each `safeStatBytes` is cheap but `sumDirMarkdownBytes`
 * may iterate dozens of memory files.
 *
 * @param {Object} args
 * @param {string} args.kind       provider kind — "claude-code" / "anthropic-api" / etc.
 * @param {string} args.vaultPath  absolute path to the active vault
 * @param {string} [args.homeDir]  override for tests; defaults to os.homedir()
 * @param {Object} [args.settings] active settings (for future MCP toggles)
 * @returns {Promise<ContextSourcesSnapshot>}
 *
 * @typedef {Object} ContextSourcesSnapshot
 * @property {number} ccSystemPromptTokens   — built-in CC prompt baseline
 * @property {number} toolSchemaTokens       — CC/SDK tool definitions baseline
 * @property {number} userClaudeMdTokens     — ~/.claude/CLAUDE.md
 * @property {number} homeClaudeMdTokens     — ~/CLAUDE.md
 * @property {number} vaultClaudeMdTokens    — <vault>/CLAUDE.md
 * @property {number} vaultAgentsMdTokens    — <vault>/AGENTS.md
 * @property {number} memoryMdTokens         — auto-memory MEMORY.md (capped at 24KB by CC)
 * @property {number} memoryDirTokens        — sum of *.md in memory dir (worst case)
 * @property {number} memoryFileCount        — # of `.md` files in memory dir (for UI)
 */
async function collectContextSources({ kind, vaultPath, homeDir, settings }) {
  const home = homeDir || os.homedir() || "";
  const isClaudeCode = kind === "claude-code";
  const isSdk = kind === "anthropic-api" || kind === "openai-api" || kind === "google-api";

  // System-prompt + tool-schema baselines depend on whether CC owns the
  // prompt (CLI mode) or Gryphon does (SDK mode). Codex-CLI / Gemini-CLI
  // fall through to the SDK baseline as a coarse approximation — refine
  // in v1.7.x if telemetry suggests they're materially different.
  const ccSystemPromptTokens = isClaudeCode
    ? CC_SYSTEM_PROMPT_TOKENS_BASELINE
    : SDK_SYSTEM_PROMPT_TOKENS_BASELINE;
  const toolSchemaTokens = isClaudeCode
    ? CC_TOOL_SCHEMAS_TOKENS_BASELINE
    : SDK_TOOL_SCHEMAS_TOKENS_BASELINE;

  // CLAUDE.md hierarchy. CC auto-loads up to four files in this order:
  //   ~/.claude/CLAUDE.md   — global (cross-project)
  //   ~/CLAUDE.md           — user-home (cross-project, secondary)
  //   <vault>/CLAUDE.md     — project (primary, almost always present)
  //   <vault>/AGENTS.md     — project (Codex/Gemini-compatible alias)
  // We stat each individually so the breakdown UI can attribute bytes
  // correctly (the user clicking "Project CLAUDE.md" should jump to the
  // vault file, not the global one).
  const userClaudeMdTokens = estimateTokensFromBytes(safeStatBytes(path.join(home, ".claude", "CLAUDE.md")));
  const homeClaudeMdTokens = estimateTokensFromBytes(safeStatBytes(path.join(home, "CLAUDE.md")));
  const vaultClaudeMdTokens = vaultPath
    ? estimateTokensFromBytes(safeStatBytes(path.join(vaultPath, "CLAUDE.md")))
    : 0;
  const vaultAgentsMdTokens = vaultPath
    ? estimateTokensFromBytes(safeStatBytes(path.join(vaultPath, "AGENTS.md")))
    : 0;

  // Auto-memory only applies in claude-code mode (CC's specific feature).
  // For SDK modes, return zero. Memory dir lives at:
  //   ~/.claude/projects/<escapedVaultPath>/memory/
  let memoryMdTokens = 0;
  let memoryDirTokens = 0;
  let memoryFileCount = 0;
  if (isClaudeCode && vaultPath) {
    const escapedVault = escapeVaultPath(vaultPath);
    const memoryDir = path.join(home, ".claude", "projects", escapedVault, "memory");
    const memoryMdPath = path.join(memoryDir, "MEMORY.md");
    // CC caps MEMORY.md at 24KB even if the on-disk file is larger.
    const memoryMdBytesRaw = safeStatBytes(memoryMdPath);
    const memoryMdBytesEffective = Math.min(memoryMdBytesRaw, 24 * 1024);
    memoryMdTokens = estimateTokensFromBytes(memoryMdBytesEffective);
    // memoryDirTokens is the WORST-CASE upper bound — if every memory
    // file got pulled in via @link, this is what they'd add.
    memoryDirTokens = estimateTokensFromBytes(sumDirMarkdownBytes(memoryDir)) - memoryMdTokens;
    if (memoryDirTokens < 0) memoryDirTokens = 0;
    try {
      memoryFileCount = fs.readdirSync(memoryDir)
        .filter((f) => f.endsWith(".md") && f !== "MEMORY.md").length;
    } catch (_) { /* dir missing — count stays 0 */ }
  }

  return {
    ccSystemPromptTokens,
    toolSchemaTokens,
    userClaudeMdTokens,
    homeClaudeMdTokens,
    vaultClaudeMdTokens,
    vaultAgentsMdTokens,
    memoryMdTokens,
    memoryDirTokens,
    memoryFileCount,
  };
}

/**
 * Combine the filesystem snapshot with the live per-keystroke inputs
 * (chat history + user input) and return the projection used by the
 * chip + breakdown popover. Pure function — no I/O, safe to call from
 * a 300ms-debounced keyup handler.
 *
 * @param {Object} args
 * @param {ContextSourcesSnapshot} args.sources       — from collectContextSources
 * @param {Array<{text:string}>}   args.messages      — Gryphon-tracked chat history (SDK mode primarily; CLI mode uses post-turn measurement for history)
 * @param {string}                 args.userInput     — current input-box contents
 * @param {number}                 args.windowSize    — model's context window in tokens
 * @param {number}                 [args.measuredHistoryTokens]  — when CC has reported actual history tokens, use this instead of estimating from messages
 * @param {number}                 [args.calibrationDelta]       — Stage D self-tuning offset (positive = our estimator under-counts; add this)
 * @returns {ContextProjection}
 *
 * @typedef {Object} ContextProjection
 * @property {number} totalTokens
 * @property {number} pct                — clamp(0, 100)
 * @property {number} rawPct             — uncapped (can exceed 100 — useful for the popover)
 * @property {Object} bySource           — same keys as ContextSourcesSnapshot, plus chatHistory + userInput
 * @property {boolean} likelyOverflow    — totalTokens > windowSize * 0.95
 */
function summarizeContext({ sources, messages, userInput, windowSize, measuredHistoryTokens, calibrationDelta }) {
  const safeSources = sources || {};
  // Use the measured-from-LLM number if we have it; otherwise estimate
  // from message text. SDK mode tracks history client-side so messages
  // is reliable; CLI mode learns the number post-turn and we plug it in
  // here on subsequent re-projections.
  const chatHistoryTokens =
    typeof measuredHistoryTokens === "number" && measuredHistoryTokens >= 0
      ? measuredHistoryTokens
      : (Array.isArray(messages)
          ? messages.reduce((sum, m) => sum + estimateTokensFromChars(m && m.text), 0)
          : 0);
  const userInputTokens = estimateTokensFromChars(userInput);
  const delta = typeof calibrationDelta === "number" && Number.isFinite(calibrationDelta)
    ? calibrationDelta
    : 0;

  const bySource = {
    ccSystemPromptTokens: safeSources.ccSystemPromptTokens || 0,
    toolSchemaTokens: safeSources.toolSchemaTokens || 0,
    userClaudeMdTokens: safeSources.userClaudeMdTokens || 0,
    homeClaudeMdTokens: safeSources.homeClaudeMdTokens || 0,
    vaultClaudeMdTokens: safeSources.vaultClaudeMdTokens || 0,
    vaultAgentsMdTokens: safeSources.vaultAgentsMdTokens || 0,
    memoryMdTokens: safeSources.memoryMdTokens || 0,
    memoryDirTokens: safeSources.memoryDirTokens || 0,
    chatHistoryTokens,
    userInputTokens,
  };
  const totalTokens = Object.values(bySource).reduce((a, b) => a + b, 0) + delta;
  const w = typeof windowSize === "number" && windowSize > 0 ? windowSize : 200000;
  const rawPct = Math.round((totalTokens / w) * 100);
  const pct = Math.max(0, Math.min(100, rawPct));
  return {
    totalTokens,
    pct,
    rawPct,
    bySource,
    likelyOverflow: totalTokens > w * 0.95,
    windowSize: w,
  };
}

module.exports = {
  collectContextSources,
  summarizeContext,
  // Exported for tests + the breakdown popover's labels.
  estimateTokensFromChars,
  estimateTokensFromBytes,
  escapeVaultPath,
  CHARS_PER_TOKEN,
  CC_SYSTEM_PROMPT_TOKENS_BASELINE,
  CC_TOOL_SCHEMAS_TOKENS_BASELINE,
  SDK_SYSTEM_PROMPT_TOKENS_BASELINE,
  SDK_TOOL_SCHEMAS_TOKENS_BASELINE,
};

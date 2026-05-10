/**
 * Attack detector — single enforcement point for Gryphon's
 * protected-pattern defense. Both SDK tools and (later) the CLI
 * provider's permission_request handler route through this module.
 *
 * Design rationale in docs/v0.5.0-attack-detector-design.md.
 *
 * Responsibility scope — the detector only knows about patterns that
 * appear in the active protected-paths / protected-commands lists.
 * It does NOT scan content, track provenance, or make decisions
 * beyond "is this tool_use one of the user's flagged patterns."
 * Anything more is out of Gryphon's scope and is documented as
 * tool calls only; downstream threat intel is a separate concern.
 */

const path = require("path");
const {
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_PROTECTED_COMMANDS,
  PROTECTED_CATEGORIES,
} = require("./constants");
const {
  matchProtectedPath,
  resolveVaultPath,
  PathOutsideVaultError,
} = require("./path-utils");
const { checkPermission } = require("./permission-gate");

/**
 * Per-pattern de-duplication so a user with one broken regex doesn't
 * get a Notice / console warning on every classify call. First time
 * we see a bad pattern → warn loudly; subsequent classifies silently
 * skip it. Reset on plugin reload (module cache clears).
 */
const _warnedBadPatterns = new Set();
function _warnInvalidPatternOnce(pattern, err) {
  if (_warnedBadPatterns.has(pattern)) return;
  _warnedBadPatterns.add(pattern);
  const msg =
    `Gryphon: custom protected pattern "${pattern}" is not a valid regex ` +
    `(${(err && err.message) || err}). That rule is NOT enforcing — ` +
    `fix it in Settings → Gryphon → Protected commands or Protected file paths.`;
  try { console.error("[gryphon/classifier]", msg); } catch (_) {}
  try {
    // Obsidian Notice may not exist in tests / headless — guard.
    const { Notice } = require("obsidian");
    new Notice(msg, 15000);
  } catch (_) { /* not running under Obsidian — console is enough */ }
}

/**
 * Merge the user's disabled + custom settings with the built-in defaults
 * and return the set of active pattern definitions, each still carrying
 * its category / userRisk / explanation metadata. Mirrors
 * `resolveActivePatterns` in path-utils but preserves the metadata fields
 * (that function returns plain strings for regex compilation).
 */
function _activePatternDefs(defaults, disabled, custom) {
  const defs = Array.isArray(defaults) ? defaults : [];
  const off = new Set(Array.isArray(disabled) ? disabled : []);
  const normalizedDefs = defs
    .map((d) => {
      if (typeof d === "string") return { pattern: d };
      if (d && typeof d.pattern === "string") return d;
      return null;
    })
    .filter((d) => d && !off.has(d.pattern));
  const custs = Array.isArray(custom)
    ? custom
        .filter((p) => typeof p === "string" && p.length > 0)
        .map((p) => ({
          pattern: p,
          category: "user-custom",
          userRisk:
            `This matches a pattern you added to Gryphon's protected list (\`${p}\`). ` +
            `Gryphon is prompting because the tool call looked like what you told it to watch for.`,
          explanation: "User-added pattern.",
        }))
    : [];
  return [...normalizedDefs, ...custs];
}

function _categoryTitle(category) {
  return PROTECTED_CATEGORIES[category] || "⚠ Matches a protected pattern";
}

/**
 * Classify a proposed tool invocation against the user's active
 * protected-pattern list.
 *
 * @param {string} tool  — "Write" | "Edit" | "Bash" | "PowerShell" | other
 * @param {object} input — tool input object (same shape as tool_use.input)
 * @param {object} ctx   — { vaultRoot, plugin, ... }
 * @returns {object|null}
 *   null if no protected pattern matched; otherwise:
 *   { tool, matchedPattern, category, title, userRisk, technicalDetail }
 */
/**
 * Cross-CLI tool-name aliases. Different CLIs name the same tool
 * differently — Claude Code's "Bash" is Gemini's "run_shell_command",
 * Codex's "command_execution", and so on. The classifier internally
 * speaks Claude Code's tool vocabulary (Bash / Write / Edit /
 * PowerShell), so we normalize incoming names before dispatching.
 *
 * Adding a new CLI = add its tool names here. The classifier itself
 * stays vocabulary-pure.
 */
const TOOL_ALIASES = {
  // Shell / command execution
  "Bash": "Bash",
  "PowerShell": "PowerShell",
  "run_shell_command": "Bash",  // Gemini CLI / Gemini SDK
  "shell": "Bash",              // Gemini variants seen in older builds
  "bash": "Bash",                // ditto
  "command_execution": "Bash",   // Codex JSONL item.type (defensive — Codex's hook
                                  //   uses tool_name, not item.type, but hook input
                                  //   shape may evolve)
  // File mutation
  "Write": "Write",
  "Edit": "Edit",
  "write_file": "Write",         // Gemini CLI / SDK
  "replace": "Edit",             // Gemini CLI / SDK
  "edit_file": "Edit",           // Gemini variant
  // File read — not protected (read-only tools never reach the
  // permission gate), but listed here so downstream consumers like
  // chat-view's status-line normalizer can map snake_case SDK names
  // ("read_file") to a single user-friendly label ("Reading...")
  // without leaking the raw identifier into the UI.
  "Read": "Read",
  "read_file": "Read",           // OpenAI / Gemini SDK
  "Glob": "Glob",
  "glob": "Glob",
  "list_directory": "Glob",      // Gemini SDK
  "list_files": "Glob",          // OpenAI / common variant
  "Grep": "Grep",
  "grep": "Grep",
  "search_files": "Grep",        // common SDK variant
  "search_file_content": "Grep", // Gemini SDK
};

function classify(tool, input, ctx) {
  if (!tool || !input) return null;
  const settings = (ctx && ctx.plugin && ctx.plugin.settings) || {};

  // Normalize provider-specific tool names to the Claude-Code vocabulary
  // the per-tool branches below understand. Unknown names pass through
  // and hit the "not currently gated" branch (correct default).
  const canonical = TOOL_ALIASES[tool] || tool;

  if (canonical === "Write" || canonical === "Edit") {
    // Master toggle — when the user turns off Protected file paths
    // entirely, return null so gate() treats it as non-protected and
    // the normal permission-mode policy applies (Prompt/Safe/YOLO all
    // respected as the user chose for routine operations).
    if (settings.protectedPathsEnabled === false) return null;
    // Gemini's write_file uses `file_path` already, but `replace`
    // uses `file_path` too (Gemini's docs). _classifyFilePath reads
    // input.file_path; if a future CLI uses a different field, add
    // a normalizer here similar to TOOL_ALIASES.
    return _classifyFilePath(canonical, input, ctx, settings);
  }
  // "PowerShell" is CC's shell-command tool on Windows; it carries the
  // same `{command, description}` shape as Bash and needs the same
  // protected-pattern scan. Without this routing, Windows users got zero
  // protection on shell-style deletes (Remove-Item, del /s, format D:) —
  // CC's cwd-restriction happened to catch obvious cases but missed any
  // destructive command targeting a path inside the vault.
  if (canonical === "Bash" || canonical === "PowerShell") {
    if (settings.protectedCommandsEnabled === false) return null;
    return _classifyCommand(canonical, input, ctx, settings);
  }
  // Read / Glob / Grep / WebFetch / WebSearch are not currently gated —
  // their outputs carry the threat, not their inputs. Returning null
  // here keeps the detector a no-op for them (permission-gate still
  // handles its existing policy for tools that call it).
  return null;
}

function _classifyFilePath(tool, input, ctx, settings) {
  const vaultRoot = ctx && ctx.vaultRoot;
  if (!vaultRoot) return null;
  const filePath = input.file_path;
  if (typeof filePath !== "string" || !filePath) return null;

  let resolved;
  try {
    resolved = resolveVaultPath(filePath, vaultRoot);
  } catch (e) {
    // PathOutsideVaultError is legitimate — the SDK tool's own
    // resolveVaultPath rejects these, so the file never reaches a
    // write/edit. Not our domain; return null so gate() routes via
    // the caller's permission mode. ANY OTHER error (EIO from a
    // flaky mount, EACCES reading a parent dir, symlink loops)
    // indicates we can't evaluate the path — fail closed by
    // re-throwing so _handleClassifyRequest's outer catch returns
    // `{decision:"deny"}` with a visible reason, rather than
    // silently allowing an unclassifiable path.
    if (e instanceof PathOutsideVaultError) return null;
    throw e;
  }

  const rawRel = path.relative(vaultRoot, resolved).replace(/\\/g, "/");
  // Same normalization as command-path matching: NFKC + zero-width strip.
  // Closes naïve Unicode obfuscation on file paths if CC ever emits one.
  const rel = _normalizeForMatch(rawRel);
  const defs = _activePatternDefs(
    DEFAULT_PROTECTED_PATHS,
    settings.protectedPathsDisabled,
    settings.protectedPathsCustom,
  );

  for (const def of defs) {
    if (matchProtectedPath(rel, [def.pattern])) {
      return {
        tool,
        matchedPattern: def.pattern,
        category: def.category || "user-custom",
        title: _categoryTitle(def.category),
        userRisk: def.userRisk || def.explanation ||
          `Target path matches the protected pattern "${def.pattern}".`,
        technicalDetail:
          `Tool:            ${tool}\n` +
          `Target path:     ${rawRel}\n` +
          `Matched pattern: ${def.pattern}`,
      };
    }
  }
  return null;
}

// Normalize command strings before regex matching. NFKC collapses
// Unicode compatibility characters (fullwidth `ｒｍ` → ASCII `rm`),
// and the second pass strips zero-width characters that would otherwise
// break `\brm\b` style boundaries ("r​m" with a ZWSP in the middle).
// Cyrillic homoglyphs (`рm`) use distinct codepoints — a confusables
// fold table could close that gap, but the threat profile doesn't
// justify the table's bundle-size cost. See docs/adr/0001.
function _normalizeForMatch(s) {
  return String(s)
    .normalize("NFKC")
    .replace(/[​-‍﻿⁠]/g, "");
}

function _classifyCommand(tool, input, ctx, settings) {
  const rawCommand = input && typeof input.command === "string" ? input.command : "";
  if (!rawCommand) return null;
  const command = _normalizeForMatch(rawCommand);
  const defs = _activePatternDefs(
    DEFAULT_PROTECTED_COMMANDS,
    settings.protectedCommandsDisabled,
    settings.protectedCommandsCustom,
  );
  for (const def of defs) {
    let re;
    try {
      re = new RegExp(def.pattern, "i");
    } catch (compileErr) {
      // Invalid custom regex — we can't just silently skip, because
      // the user added this pattern expecting it to enforce. Surface
      // via a one-time-per-pattern warning so they can fix it in
      // Settings. Classifier still skips this rule (can't match with
      // an un-compilable regex) but every OTHER rule still runs.
      _warnInvalidPatternOnce(def.pattern, compileErr);
      continue;
    }
    if (re.test(command)) {
      return {
        tool,
        matchedPattern: def.pattern,
        category: def.category || "user-custom",
        title: _categoryTitle(def.category),
        userRisk: def.userRisk || def.explanation ||
          `Command matches the protected pattern "${def.pattern}".`,
        technicalDetail:
          `Tool:            ${tool}\n` +
          `Command:         ${rawCommand}\n` +
          `Matched pattern: ${def.pattern}`,
      };
    }
  }
  return null;
}

/**
 * Decide whether to allow a tool call.
 *
 * If classification is non-null, we fire the protected-operation modal
 * (it overrides Safe/YOLO). Otherwise we fall through to the standard
 * permission-gate flow for the caller's mode policy.
 *
 * @param {object|null} classification — classify() result
 * @param {object} opts
 *   ctx, action, target, detail — same as checkPermission
 *   kind — "fileEdit" or "exec"
 *   cacheable — same as checkPermission (only applied when unprotected)
 * @returns {Promise<{allow, reason}>}
 */
async function gate(classification, opts) {
  const {
    ctx,
    action,
    target,
    detail,
    kind = "fileEdit",
    cacheable = true,
  } = opts || {};

  if (classification) {
    const protectedKind = kind === "exec" ? "protected-exec" : "protected";
    const combinedDetail = classification.technicalDetail
      + (detail ? `\n\n--- details ---\n${detail}` : "");
    return await checkPermission({
      ctx,
      action,
      target,
      detail: combinedDetail,
      kind: protectedKind,
      cacheable: false,
      warning: classification.userRisk,
      category: classification.category,
      categoryTitle: classification.title,
    });
  }

  return await checkPermission({
    ctx,
    action,
    target,
    detail,
    kind,
    cacheable,
  });
}

/**
 * Public helper: normalize a provider-specific tool name to the
 * Claude-Code vocabulary. Returns the input unchanged when no alias
 * is registered. Exposed because `_handleClassifyRequest` in
 * plugin.js needs to make the same isMutating / kind decisions
 * `classify()` makes internally — without it, the Bash/PowerShell
 * branches there fail to fire for Gemini's `run_shell_command`,
 * the modal-construction picks wrong kind, and the user sees a
 * generic deny instead of the category-specific reason
 * ("(destructive operation)"). User report 2026-05-03.
 */
function normalizeToolName(tool) {
  return TOOL_ALIASES[tool] || tool;
}

module.exports = {
  classify,
  gate,
  normalizeToolName,
  // Exported for unit tests only:
  _activePatternDefs,
  _categoryTitle,
  TOOL_ALIASES,
};

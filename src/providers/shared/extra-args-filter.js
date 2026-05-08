/**
 * Per-provider extraArgs filtering (issue #39).
 *
 * Background: GryphonChatView's `extraProcessArgs` option lets consumers
 * append flags to every CLI provider's spawn args. Today, every provider
 * blindly forwards them — so when a consumer (e.g. Athena) wires up
 * Claude-Code-only flags like `--disable-slash-commands`, the codex-cli
 * and gemini-cli spawns fail with "unknown argument."
 *
 * This module centralizes per-provider knowledge of which flags belong
 * to which CLI, so each provider's adapter can drop cross-provider flags
 * before passing the rest to its own spawn.
 *
 * Conservative inclusion: only flags KNOWN to break a different
 * provider's spawn are listed here. A flag we haven't enumerated passes
 * through untouched, on the theory that consumers know what they're
 * doing for flags Gryphon doesn't recognize. The result is "drop the
 * obvious mismatches; trust the consumer for everything else."
 *
 * For consumers that want clean per-provider routing without relying on
 * this filter, the recommended path is `options.extraProcessArgsByProvider`
 * — see `src/providers/factory.js` for the merge logic.
 */

// Flags specific to each provider's CLI. Inclusion criterion: this flag
// is known to be unique to one CLI and would break a different one if
// forwarded. Routine flags (e.g. `--model`, `--debug`) are NOT listed
// here — they appear on multiple CLIs or pass through harmlessly.
const PROVIDER_FLAGS = {
  "claude-code": new Set([
    "--disable-slash-commands",
    "--allowedTools",
    "--disallowedTools",
    "--append-system-prompt",
    "--max-thinking-tokens",
    "--permission-prompt-tool",
    "--continue",
    "--input-format",
    "--output-format",
    "--print",
  ]),
  "codex-cli": new Set([
    // `--disable` is Codex's structured-disable flag, distinct from
    // Claude's `--disable-slash-commands`. Listed so a Claude consumer's
    // `--disable-slash-commands` doesn't accidentally pass through to
    // Codex via the unknown-flag passthrough path.
    "--disable",
    "--disable-tool",
    "--skip-git-repo-check",
  ]),
  "gemini-cli": new Set([
    "--approval-mode",
  ]),
};

// Union of all provider-specific flags. A flag in this set is "owned" by
// some provider; if the active provider doesn't own it, drop it.
const ALL_PROVIDER_FLAGS = new Set();
for (const set of Object.values(PROVIDER_FLAGS)) {
  for (const f of set) ALL_PROVIDER_FLAGS.add(f);
}

function isFlagToken(s) {
  return typeof s === "string" && s.startsWith("--");
}

/**
 * Filter `extraArgs` for the active provider, dropping cross-provider
 * flags. Each flag is classified as:
 *   - "owned by my provider" → keep (and its value if any)
 *   - "owned by another provider" → drop (and its value if any)
 *   - "unknown / generic" → keep (consumer's call)
 *
 * Value detection: a token immediately after a flag is treated as the
 * flag's value if it doesn't itself start with `--`. This handles the
 * common `--flag <value>` form. Edge case: `--flag` (no value) followed
 * by `--anotherflag` is correctly classified — the next-token-is-flag
 * check matches, so no value is consumed.
 *
 * @param {string[]} extraArgs       — the flat array of CLI tokens
 * @param {string}   providerKind    — active provider id ("claude-code", "codex-cli", "gemini-cli")
 * @returns {{ filtered: string[], dropped: string[] }}
 */
function filterExtraArgs(extraArgs, providerKind) {
  if (!Array.isArray(extraArgs) || extraArgs.length === 0) {
    return { filtered: [], dropped: [] };
  }
  const myFlags = PROVIDER_FLAGS[providerKind] || new Set();
  const filtered = [];
  const dropped = [];

  let i = 0;
  while (i < extraArgs.length) {
    const arg = extraArgs[i];

    // Non-flag tokens at the top level (rare — usually values follow a
    // flag and are consumed below). Pass through; could be a positional
    // argument the consumer supplied for some CLI that takes one.
    if (!isFlagToken(arg)) {
      filtered.push(arg);
      i++;
      continue;
    }

    const isMine = myFlags.has(arg);
    const isOthers = !isMine && ALL_PROVIDER_FLAGS.has(arg);

    if (isOthers) {
      // Cross-provider flag — drop it AND its value (if it has one).
      dropped.push(arg);
      if (i + 1 < extraArgs.length && !isFlagToken(extraArgs[i + 1])) {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // Mine OR unknown. Keep flag + value-if-any.
    filtered.push(arg);
    if (i + 1 < extraArgs.length && !isFlagToken(extraArgs[i + 1])) {
      filtered.push(extraArgs[i + 1]);
      i += 2;
    } else {
      i++;
    }
  }

  return { filtered, dropped };
}

module.exports = {
  filterExtraArgs,
  PROVIDER_FLAGS,
  ALL_PROVIDER_FLAGS,
};

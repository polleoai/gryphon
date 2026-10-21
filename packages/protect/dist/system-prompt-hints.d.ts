/**
 * Shared Gryphon system-prompt hints.
 *
 * These directives are appended to whichever provider's prompt
 * surface accepts them (Claude Code: --append-system-prompt; Codex:
 * model_instructions_file; Gemini: equivalent). Centralized so that
 * every provider that integrates with Gryphon's PreToolUse-hook
 * deny-flow surfaces refusals to the user identically — no leaking
 * "PreToolUse hook" / "intercept" / "sandbox" terminology, no
 * mechanism-narration, just the deny reason verbatim plus the
 * "open Settings → uncheck the pattern" instruction.
 *
 * Historically these constants lived inline in claude-code.js. They
 * were promoted to shared in v1.3 Stage 2.5 once Codex CLI gained
 * the same hook protocol — the directives are 100% provider-agnostic
 * (every line refers to "Gryphon's protected-pattern list" not
 * "Claude Code"), so reuse is safe and keeps the wording in lockstep
 * across providers.
 *
 * IMPORTANT — NO embedded newlines in GRYPHON_SYSTEM_PROMPT_HINT.
 * It's passed as a command-line arg to claude on every spawn. On
 * Windows, Node's `shell: true` joins args into a single cmd.exe
 * command string, and cmd.exe does not reliably preserve newlines
 * inside quoted args — any `\n` in this string truncates the
 * argument at the newline and drops every flag that came after it
 * in the argv (including `--settings`, which is how we register our
 * hooks). Bullet-style "· " separators preserve the paragraph
 * structure for the model without breaking the shell handoff.
 *
 * The Codex injection path uses a model_instructions_file (no shell
 * quoting concerns), but we still keep newline-free for symmetry —
 * if a future provider needs the argv path again, this constant
 * stays usable as-is.
 */
declare const GRYPHON_SYSTEM_PROMPT_HINT: string;
declare const GRYPHON_FALLBACK_DENY_HINT: string;
/**
 * SDK-flavored compound-request rule. Same intent as the CLI
 * COMPOUND REQUESTS clause inside GRYPHON_SYSTEM_PROMPT_HINT, but
 * cross-references the SDK-side "output ONLY that reason" wording
 * (the SDK system prompts use that phrasing rather than "verbatim").
 *
 * Without this rule, the SDK providers (anthropic-api / openai-api /
 * google-api) silently drop the safe sub-request when a compound
 * prompt contains a refused tool. Concretely: "summarize the file
 * AND delete it" with rm protected → SDK model would deliver only
 * the summary OR only the deny, never both. User report 2026-05-04.
 *
 * Append this string to each SDK system prompt's existing rules
 * block. Single space at the start so it concatenates cleanly.
 */
declare const GRYPHON_SDK_COMPOUND_REQUEST_RULE: string;
export { GRYPHON_SYSTEM_PROMPT_HINT, GRYPHON_FALLBACK_DENY_HINT, GRYPHON_SDK_COMPOUND_REQUEST_RULE, };

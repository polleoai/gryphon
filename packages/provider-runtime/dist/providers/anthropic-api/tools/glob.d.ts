/**
 * Glob tool — recursive file matching against a glob pattern.
 *
 * Matches Claude Code's Glob behavior: returns file paths sorted by
 * modification time (newest first), capped at 250 entries by default.
 * Supports `**`, `*`, `?`, and `{a,b,c}` brace expansion.
 *
 * Implementation uses a minimal glob→regex translator (no extra deps).
 * For complex patterns we'd want picomatch, but the common cases
 * (`**\/*.md`, `src/**\/*.js`, `*.{ts,tsx}`) are well covered here.
 */
export {};

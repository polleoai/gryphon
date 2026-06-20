/**
 * Grep tool — content search across files using a regex pattern.
 *
 * Mirrors Claude Code's Grep but implemented in pure Node (no ripgrep
 * dependency). For very large vaults this will be slower than rg —
 * acceptable tradeoff for Anthropic API mode where we need pure-JS portability.
 *
 * Output modes:
 *   "content"            — matching lines with line numbers (default)
 *   "files_with_matches" — paths only, one per line
 *   "count"              — match count per file
 */
export {};

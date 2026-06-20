/**
 * Edit tool — exact-string replacement in an existing file.
 *
 * Mirrors Claude Code's Edit contract:
 *   - old_string must appear in the file (else error)
 *   - old_string must be unique (else error: "non-unique match")
 *   - replace_all=true bypasses the uniqueness check (replaces every
 *     occurrence; useful for renames)
 *
 * The exact-match contract forces the model to Read the file first to
 * get the actual content (whitespace, line endings, etc.). This is what
 * makes Edit safer than diff-based patches: there's no fuzzy matching to
 * silently apply the wrong change.
 *
 * Permission-gated like Write.
 */
export {};

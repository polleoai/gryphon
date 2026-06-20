/**
 * Write tool — full-file write (creates or overwrites).
 *
 * Mirrors Claude Code's Write contract. Creates parent directories
 * automatically. Permission-gated: refuses in plan mode, prompts in
 * default mode, auto-allows in acceptEdits / bypassPermissions.
 *
 * Safety: path resolves through resolveVaultPath (vault-only). Never
 * touches files outside the vault, even with bypassPermissions.
 */
export {};

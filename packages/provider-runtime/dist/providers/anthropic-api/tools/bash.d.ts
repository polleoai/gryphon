/**
 * Bash tool — execute shell commands in the vault directory.
 *
 * The highest-stakes tool in the registry. Permission gating is
 * NEVER cached (each command is its own decision; allowing `ls` once
 * must not allow `rm -rf` later) and the modal shows the exact command
 * verbatim so the user sees what they're authorizing.
 *
 * Modes:
 *   plan                 → refused
 *   default              → prompt per command, no remember toggle
 *   acceptEdits          → auto-allowed (matches CC parity)
 *   bypassPermissions    → auto-allowed
 *
 * Execution:
 *   - cwd = vault root
 *   - timeout = 120s default, capped at 600s (matching CC)
 *   - stdout + stderr captured and returned
 *   - non-zero exit reported with code, but is_error=false (the model
 *     should see and reason about the failure, not have it suppressed)
 */
export {};

/**
 * Vault MCP server approval UX (issue #25, Design rev 2).
 *
 * The claude-code provider leaves out every vault `.mcp.json` server that no
 * out-of-vault approval matches, and hands the list to the host through
 * `hostAdapter.mcpApprovalsPending`. This module is that host side:
 *
 *   - a Notice ("…haven't been approved. They won't run.") with a Review
 *     button — once per (vault, name, spec hash) per Obsidian session;
 *   - the review modal: each server's full command line (or URL), cwd, and
 *     env / header values (masked only when the key looks secret), marked
 *     new or changed, with Approve per server and Not now;
 *   - Settings → Advanced → "Approved vault MCP servers" with Revoke.
 *
 * Approve / revoke write the store in the user profile (never the vault)
 * and bump `plugin.mcpApprovalsGeneration`, which is part of the chat's
 * spawn signature — the next message respawns with --resume under the new
 * server set. The approval is for the hash that was SHOWN: if the file
 * changes between review and click, the new spec simply isn't approved.
 */
export {};

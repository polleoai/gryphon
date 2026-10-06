/**
 * Claude Code launch scope (issue #25).
 *
 * By default a Gryphon chat runs with the VAULT's Claude Code config, not
 * the user's personal one: the `user` setting source is dropped (personal
 * plugins, their hooks/skills/output styles, personal MCP servers), MCP is
 * strict, and auto-memory is off. Gryphon's own guardrail hooks still fire —
 * they arrive through `--settings`, which is a flag source, not `user`.
 *
 * MCP trust (Design rev 2). An entry in `<cwd>/.mcp.json` is a command line
 * and the cwd is a vault — shared, synced, cloned. A vault server runs only
 * when an approval stored OUTSIDE the vault (`@gryphon/protect` mcpApprovals,
 * injected here as `ctx.approvals`) matches its exact spec hash. Everything
 * else is left out and returned in `pendingApprovals` for the host to offer.
 * Approval files inside the vault (`.claude/settings*.json`,
 * `enabledMcpjsonServers`, Gryphon's own `data.json`) count for nothing.
 *
 * This module is pure resolution: it reads `<cwd>/.mcp.json` and asks the
 * injected reader, but writes nothing. The provider owns temp files.
 *
 * Consumer contract (`options.claudeCodeScope`):
 *   inheritUserConfig  default false → --setting-sources project,local
 *   settingSources     explicit list; wins over inheritUserConfig
 *   mcpServers         "project" (default): APPROVED vault servers only
 *                      { name: spec }: these servers + approved vault ones
 *                        (unless includeProjectMcp:false). Executed WITHOUT
 *                        approval — build them from your plugin's own code,
 *                        never from files inside the vault. A name here
 *                        shadows the vault entry of the same name.
 *                      "inherit": the user's MCP config (non-strict), with
 *                        every unapproved vault server named in
 *                        `disabledMcpjsonServers` — a flag-source setting,
 *                        which beats project/local `enableAllProjectMcpServers`
 *                        (live-probed on claude 2.1.291). Fails closed to
 *                        strict MCP when that guard can't hold: an
 *                        unparseable `.mcp.json`, a consumer `--settings`
 *                        that could override it, or (provider side) a
 *                        settings file that couldn't be written.
 *   includeProjectMcp  default true when mcpServers is an object
 *   autoMemory         default false (scoped) / untouched (inheritUserConfig)
 *
 * Any of `--setting-sources`, `--strict-mcp-config`, `--mcp-config`,
 * `--name` already present in the consumer's extraArgs suppresses
 * Gryphon's own value for that flag — consumers stay in control. (A
 * consumer `--mcp-config` is trusted code; a consumer that drops
 * `--strict-mcp-config` from a scoped launch owns that choice.)
 */
interface ClaudeCodeScopeOptions {
    inheritUserConfig?: boolean;
    settingSources?: string[];
    mcpServers?: "project" | "inherit" | Record<string, any>;
    includeProjectMcp?: boolean;
    autoMemory?: boolean;
}
/** Reads the out-of-vault approval store: the approved spec hash, or null. */
interface McpApprovalsReader {
    lookup(vaultKey: string, name: string): string | null;
}
interface PendingApproval {
    name: string;
    /** The raw `.mcp.json` entry, for the review modal. May hold secrets in env/headers. */
    spec: any;
    specHash: string;
    reason: "new" | "changed";
}
interface ResolvedScope {
    /** Args Gryphon adds to the CLI argv (excluding --mcp-config, whose path the caller supplies). */
    args: string[];
    /** Servers for the --mcp-config temp file; null = emit no --mcp-config. */
    mcpServers: Record<string, any> | null;
    /** Keys merged into the --settings flag object; empty = nothing to add. */
    settingsKeys: Record<string, any>;
    /** Problems that cost the session its vault MCP servers (malformed .mcp.json). */
    warnings: string[];
    /** Vault servers left out because nothing outside the vault approved their exact spec. */
    pendingApprovals: PendingApproval[];
    /** realpath(cwd) — the approval store's key for this vault. */
    vaultKey: string;
    /** One-line summary for devCliDebug logging. */
    summary: {
        settingSources: string | null;
        strictMcp: boolean;
        mcpServerNames: string[] | "inherit";
        pendingApproval: string[];
        autoMemory: boolean | "inherit";
    };
}
/**
 * Read `<cwd>/.mcp.json`. Missing file → `{ servers: {} }` (not an error:
 * most vaults have none). Unreadable / malformed → `{ servers: {}, error }`.
 */
declare function readProjectMcpServers(cwd: string): {
    servers: Record<string, any>;
    error?: string;
};
declare function resolveClaudeCodeScope(scope: ClaudeCodeScopeOptions | null | undefined, ctx: {
    cwd: string;
    extraArgs?: string[];
    approvals?: McpApprovalsReader | null;
}): ResolvedScope;
export { resolveClaudeCodeScope, readProjectMcpServers };
export type { ClaudeCodeScopeOptions, ResolvedScope, McpApprovalsReader, PendingApproval };

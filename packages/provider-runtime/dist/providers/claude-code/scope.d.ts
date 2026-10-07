/**
 * Claude Code launch scope (issues #25, #27).
 *
 * The rule (#27): a file inside the vault can add protection, but it can
 * never remove protection or run code. The vault is the cwd, and vaults are
 * shared, synced and cloned. Headless Claude Code (stream-json) skips its
 * workspace-trust prompt, so anything it loads from the vault runs zero-
 * click: `.claude/settings.json` / `settings.local.json` hooks, `env`,
 * `apiKeyHelper`, `statusLine`, … — and `.mcp.json` server commands.
 *
 * Settings sources. A scoped launch (default) loads NO settings files
 * (`--setting-sources=`); inherit mode loads only `user` (the user's own
 * `~/.claude/settings.json`, outside the vault). Gryphon's guardrail hooks
 * and keys still arrive through `--settings`, a flag source. Dropping
 * `project` also drops what Claude Code discovers through it — the vault's
 * CLAUDE.md and `.claude/{skills,agents,commands}` — so consumers carry
 * those back explicitly with `memoryFiles` and `pluginDirs`.
 *
 * MCP trust (#25 Design rev 2). An entry in `<cwd>/.mcp.json` is a command
 * line. A vault server runs only when an approval stored OUTSIDE the vault
 * (`@gryphon/protect` mcpApprovals, injected here as `ctx.approvals`)
 * matches its exact spec hash. Everything else is left out and returned in
 * `pendingApprovals` for the host to offer. Approval files inside the vault
 * (`.claude/settings*.json`, `enabledMcpjsonServers`, Gryphon's own
 * `data.json`) count for nothing. Every mode launches `--strict-mcp-config`
 * with a `--mcp-config` Gryphon writes from the objects it parsed and
 * hashed, so Claude Code never re-reads `.mcp.json` (no approve-then-swap
 * race, #27 Part B).
 *
 * This module is pure resolution: it reads `<cwd>/.mcp.json`,
 * `~/.claude.json` (inherit only) and asks the injected reader, but writes
 * nothing. The provider owns temp files.
 *
 * Consumer contract (`options.claudeCodeScope`). Every field defaults on
 * its own: a scope that sets only `memoryFiles` behaves exactly like
 * `undefined` on every other field.
 *   inheritUserConfig  default false → --setting-sources= (no files);
 *                      true → --setting-sources=user
 *   settingSources     explicit list; wins over inheritUserConfig. Listing
 *                      `project` or `local` loads vault files that can run
 *                      commands — honoured (the consumer owns that choice)
 *                      and logged on every spawn.
 *   mcpServers         "project" (default): APPROVED vault servers only
 *                      { name: spec }: these servers + approved vault ones
 *                        (unless includeProjectMcp:false). Executed WITHOUT
 *                        approval — build them from your plugin's own code,
 *                        never from files inside the vault. A name here
 *                        shadows the vault entry of the same name.
 *                      "inherit": the user's own servers from
 *                        `~/.claude.json` (top-level + this vault's
 *                        local-scope entry, both outside the vault) +
 *                        approved vault servers. claude.ai connectors and
 *                        plugin-provided servers don't load.
 *   includeProjectMcp  default true when mcpServers is an object
 *   autoMemory         default false (scoped) / untouched (inheritUserConfig)
 *   pluginDirs         absolute paths → one --plugin-dir each. TRUSTED
 *                      directories the consumer ships in its own install —
 *                      a plugin dir can carry hooks, so never point it at
 *                      vault content.
 *   memoryFiles        absolute paths the consumer names in code (e.g. its
 *                      vault CLAUDE.md). Assembled with @-imports expanded
 *                      (./memory-appendix.ts) into ONE
 *                      --append-system-prompt-file. Never inferred.
 *
 * Any of `--setting-sources`, `--strict-mcp-config`, `--mcp-config`,
 * `--plugin-dir`, `--name` already present in the consumer's extraArgs
 * suppresses Gryphon's own value for that flag — consumers stay in
 * control. (A consumer `--mcp-config` is trusted code; a consumer that
 * drops `--strict-mcp-config` owns that choice.) The exception is
 * `--append-system-prompt-file` with `memoryFiles` set: the CLI keeps only
 * the last value, so one set of rules would vanish silently — that's a
 * contract error and the resolver throws.
 */
interface ClaudeCodeScopeOptions {
    inheritUserConfig?: boolean;
    settingSources?: string[];
    mcpServers?: "project" | "inherit" | Record<string, any>;
    includeProjectMcp?: boolean;
    autoMemory?: boolean;
    pluginDirs?: string[];
    memoryFiles?: string[];
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
    /** Inherit mode: names in mcpServers that are the user's own (not vault/consumer). */
    personalMcpServerNames: string[];
    /** Consumer memory files for the provider to assemble (./memory-appendix.ts); empty = none. */
    memoryFiles: string[];
    /** One-line summary for devCliDebug logging. */
    summary: {
        settingSources: string;
        strictMcp: boolean;
        mcpServerNames: string[];
        pendingApproval: string[];
        autoMemory: boolean | "inherit";
        pluginDirs: string[];
        memoryFiles: string[];
    };
}
/**
 * Read `<cwd>/.mcp.json`. Missing file, or an object with no `mcpServers`
 * key → `{ servers: {} }` (not an error: most vaults have none).
 * Unreadable / malformed → `{ servers: {}, error }`.
 */
declare function readProjectMcpServers(cwd: string): {
    servers: Record<string, any>;
    error?: string;
};
/**
 * The user's own MCP servers for inherit mode (#27 Part B), from
 * `~/.claude.json` — outside the vault. `user` = top-level `mcpServers`
 * (`claude mcp add -s user`); `local` = `projects[<cwd>].mcpServers`
 * (`claude mcp add`, the default local scope). Missing file → empty, quietly
 * (a fresh install has none). Unreadable / malformed → empty + `error`:
 * it costs the personal servers only, never the spawn.
 */
declare function readUserMcpServers(file: string, cwd: string): {
    user: Record<string, any>;
    local: Record<string, any>;
    error?: string;
};
declare function resolveClaudeCodeScope(scope: ClaudeCodeScopeOptions | null | undefined, ctx: {
    cwd: string;
    extraArgs?: string[];
    approvals?: McpApprovalsReader | null;
    userConfigFile?: string;
}): ResolvedScope;
export { resolveClaudeCodeScope, readProjectMcpServers, readUserMcpServers };
export type { ClaudeCodeScopeOptions, ResolvedScope, McpApprovalsReader, PendingApproval };

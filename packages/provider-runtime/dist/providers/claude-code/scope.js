"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveClaudeCodeScope = resolveClaudeCodeScope;
exports.readProjectMcpServers = readProjectMcpServers;
const fs = require("fs");
const path = require("path");
const { mcpApprovals } = require("@gryphon/protect");
const VALID_SOURCES = new Set(["user", "project", "local"]);
const SCOPED_SOURCES = ["project", "local"];
function hasFlag(args, name) {
    return args.some((a) => typeof a === "string" && (a === name || a.startsWith(name + "=")));
}
/**
 * Read `<cwd>/.mcp.json`. Missing file → `{ servers: {} }` (not an error:
 * most vaults have none). Unreadable / malformed → `{ servers: {}, error }`.
 */
function readProjectMcpServers(cwd) {
    if (!cwd)
        return { servers: {} };
    const file = path.join(cwd, ".mcp.json");
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch (e) {
        if (e && e.code === "ENOENT")
            return { servers: {} };
        return { servers: {}, error: `couldn't read .mcp.json (${e && e.message})` };
    }
    let parsed;
    try {
        // Strip a UTF-8 BOM: Claude Code reads such a file fine, and in inherit
        // mode a parse we fail but it passes would leave servers un-disabled.
        parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    }
    catch (e) {
        return { servers: {}, error: `.mcp.json is not valid JSON (${e && e.message})` };
    }
    const servers = parsed && parsed.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
        return { servers: {}, error: `.mcp.json has no "mcpServers" object` };
    }
    return { servers };
}
/**
 * Split the vault's `.mcp.json` servers into approved (run) and pending
 * (don't). `shadowed` names are supplied by the consumer and are neither.
 * A missing reader approves nothing — fail closed.
 */
function partitionVaultServers(servers, vk, approvals, shadowed) {
    const approved = {};
    const pending = [];
    for (const [name, spec] of Object.entries(servers)) {
        if (shadowed.has(name))
            continue;
        const specHash = mcpApprovals.hashSpec(spec);
        let stored = null;
        // A name the store can't hold (`__proto__`) is never approved; it stays
        // pending so the modal can say why instead of Approve doing nothing.
        if (mcpApprovals.isApprovableName(name)) {
            try {
                stored = approvals && typeof approvals.lookup === "function" ? approvals.lookup(vk, name) : null;
            }
            catch (e) {
                console.error("[gryphon/claude-code] MCP approval lookup failed; treating as unapproved:", (e && e.message) || e);
            }
        }
        if (stored === specHash)
            approved[name] = spec;
        else
            pending.push({ name, spec, specHash, reason: stored ? "changed" : "new" });
    }
    return { approved, pending };
}
function resolveClaudeCodeScope(scope, ctx) {
    const s = scope && typeof scope === "object" ? scope : {};
    const extra = Array.isArray(ctx.extraArgs) ? ctx.extraArgs : [];
    const warnings = [];
    const args = [];
    // --- setting sources -------------------------------------------------
    let sources;
    if (Array.isArray(s.settingSources)) {
        sources = s.settingSources.filter((x) => VALID_SOURCES.has(x));
        if (sources.length !== s.settingSources.length) {
            // Consumer integration error, not a user-facing one — log only.
            console.error("[gryphon/claude-code] claudeCodeScope.settingSources: ignored unknown entries (valid: user, project, local)");
        }
    }
    else {
        sources = s.inheritUserConfig === true ? null : SCOPED_SOURCES;
    }
    const scoped = sources !== null && !sources.includes("user");
    if (sources !== null && !hasFlag(extra, "--setting-sources")) {
        args.push("--setting-sources", sources.join(","));
    }
    // --- MCP allowlist ---------------------------------------------------
    // Default follows the setting-sources choice: inheriting user config
    // inherits user MCP servers too, unless the consumer says otherwise.
    const mode = s.mcpServers !== undefined ? s.mcpServers : (s.inheritUserConfig === true ? "inherit" : "project");
    const vk = ctx.cwd ? mcpApprovals.vaultKey(ctx.cwd) : "";
    const settingsKeys = {};
    let mcpServers = null;
    let pendingApprovals = [];
    let strictMcp = false;
    if (mode !== "inherit") {
        strictMcp = true;
        const consumer = mode && typeof mode === "object" ? mode : {};
        let servers = {};
        const wantProject = mode === "project" || (typeof mode === "object" && s.includeProjectMcp !== false);
        if (wantProject) {
            const proj = readProjectMcpServers(ctx.cwd);
            if (proj.error)
                warnings.push(proj.error);
            const split = partitionVaultServers(proj.servers, vk, ctx.approvals, new Set(Object.keys(consumer)));
            servers = split.approved;
            pendingApprovals = split.pending;
        }
        // Consumer servers last: trusted code, and they win a name clash.
        servers = { ...servers, ...consumer };
        if (!hasFlag(extra, "--strict-mcp-config"))
            args.push("--strict-mcp-config");
        if (Object.keys(servers).length > 0 && !hasFlag(extra, "--mcp-config"))
            mcpServers = servers;
    }
    else {
        // Non-strict: Claude Code loads the vault's .mcp.json natively and would
        // run anything the vault's own settings approve. Disable every vault
        // server we haven't approved, through the flag-source --settings object
        // (it outranks project/local settings). A malformed .mcp.json lists no
        // names — and Claude Code can't parse it either.
        const proj = readProjectMcpServers(ctx.cwd);
        const split = proj.error ? null : partitionVaultServers(proj.servers, vk, ctx.approvals, new Set());
        if (proj.error) {
            // A .mcp.json we can't read is one we can't name servers from — and
            // Claude Code's parser may still accept it. Fail closed: strict MCP
            // with no servers for this session, and say so.
            strictMcp = true;
            if (!hasFlag(extra, "--strict-mcp-config"))
                args.push("--strict-mcp-config");
            warnings.push(`${proj.error}; your personal MCP servers are off this session too, to be safe`);
        }
        else if (split && split.pending.length > 0 && hasFlag(extra, "--settings")) {
            // The guard rides in OUR --settings object; a consumer --settings is
            // another flag-source object that could set the same key. Don't bet
            // on which wins — go strict, and say so.
            pendingApprovals = split.pending;
            strictMcp = true;
            if (!hasFlag(extra, "--strict-mcp-config"))
                args.push("--strict-mcp-config");
            warnings.push("an extra --settings flag could re-enable unapproved vault MCP servers; your personal MCP servers are off this session too, to be safe");
        }
        else if (split) {
            pendingApprovals = split.pending;
            if (pendingApprovals.length > 0)
                settingsKeys.disabledMcpjsonServers = pendingApprovals.map((p) => p.name);
        }
    }
    // --- auto-memory -----------------------------------------------------
    // Only touched when the consumer asked, or when we're scoped. Inheriting
    // user config leaves today's behaviour (and the settings file) unchanged.
    const autoMemory = typeof s.autoMemory === "boolean" ? s.autoMemory : (scoped ? false : undefined);
    if (typeof autoMemory === "boolean")
        settingsKeys.autoMemoryEnabled = autoMemory;
    // --- session label ---------------------------------------------------
    // Cosmetic: makes Gryphon sessions identifiable in `claude --resume`
    // history now that they run without the user's config. Scoped only, so
    // the inherit path keeps today's argv.
    if (scoped && ctx.cwd && !hasFlag(extra, "--name") && !extra.includes("-n")) {
        const vaultName = path.basename(ctx.cwd);
        if (vaultName)
            args.push("--name", `Gryphon · ${vaultName}`);
    }
    return {
        args,
        mcpServers,
        settingsKeys,
        warnings,
        pendingApprovals,
        vaultKey: vk,
        summary: {
            settingSources: sources === null ? null : sources.join(","),
            strictMcp,
            mcpServerNames: mode === "inherit" ? "inherit" : Object.keys(mcpServers || {}),
            pendingApproval: pendingApprovals.map((p) => `${p.name} (${p.reason})`),
            autoMemory: typeof autoMemory === "boolean" ? autoMemory : "inherit",
        },
    };
}

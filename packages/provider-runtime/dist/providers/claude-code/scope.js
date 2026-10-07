"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveClaudeCodeScope = resolveClaudeCodeScope;
exports.readProjectMcpServers = readProjectMcpServers;
exports.readUserMcpServers = readUserMcpServers;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mcpApprovals } = require("@gryphon/protect");
const VALID_SOURCES = new Set(["user", "project", "local"]);
// #27: scoped = no settings files at all; inherit = the user's own only.
const SCOPED_SOURCES = [];
const INHERIT_SOURCES = ["user"];
function hasFlag(args, name) {
    return args.some((a) => typeof a === "string" && (a === name || a.startsWith(name + "=")));
}
/**
 * Read `<cwd>/.mcp.json`. Missing file, or an object with no `mcpServers`
 * key → `{ servers: {} }` (not an error: most vaults have none).
 * Unreadable / malformed → `{ servers: {}, error }`.
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { servers: {}, error: `.mcp.json is not a JSON object` };
    }
    // No `mcpServers` key at all (e.g. `{}`) is valid and empty — Claude Code
    // loads nothing from it either (issue #28). Present but not an object
    // stays an error: fail closed.
    if (!Object.prototype.hasOwnProperty.call(parsed, "mcpServers"))
        return { servers: {} };
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
        return { servers: {}, error: `.mcp.json's "mcpServers" is not an object` };
    }
    return { servers };
}
/** `~/.claude.json`, honouring CLAUDE_CONFIG_DIR the way Claude Code does. */
function defaultUserConfigFile() {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}
/**
 * The user's own MCP servers for inherit mode (#27 Part B), from
 * `~/.claude.json` — outside the vault. `user` = top-level `mcpServers`
 * (`claude mcp add -s user`); `local` = `projects[<cwd>].mcpServers`
 * (`claude mcp add`, the default local scope). Missing file → empty, quietly
 * (a fresh install has none). Unreadable / malformed → empty + `error`:
 * it costs the personal servers only, never the spawn.
 */
function readUserMcpServers(file, cwd) {
    const empty = { user: {}, local: {} };
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch (e) {
        if (e && e.code === "ENOENT")
            return empty;
        return { ...empty, error: `couldn't read your personal MCP servers from ${path.basename(file)} (${e && e.message})` };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    }
    catch (e) {
        return { ...empty, error: `couldn't read your personal MCP servers: ${path.basename(file)} is not valid JSON (${e && e.message})` };
    }
    const asMap = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    const projects = asMap(parsed && parsed.projects);
    let local = {};
    if (cwd) {
        // Claude Code keys projects by the launch directory; try the realpath
        // and the path as given (they differ under a symlinked vault).
        const keys = [cwd];
        try {
            keys.unshift(fs.realpathSync(cwd));
        }
        catch (_) { /* keep cwd */ }
        for (const k of keys) {
            const p = Object.prototype.hasOwnProperty.call(projects, k) ? projects[k] : null;
            if (p) {
                local = asMap(p.mcpServers);
                break;
            }
        }
    }
    return { user: asMap(parsed && parsed.mcpServers), local };
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
        if (sources.includes("project") || sources.includes("local")) {
            console.error(`[gryphon/claude-code] claudeCodeScope.settingSources includes ${sources.filter((x) => x !== "user").join(",")}: ` +
                "vault settings files can run commands; consumer opted in");
        }
    }
    else {
        sources = s.inheritUserConfig === true ? INHERIT_SOURCES : SCOPED_SOURCES;
    }
    const scoped = !sources.includes("user");
    if (!hasFlag(extra, "--setting-sources")) {
        // Single token: `--setting-sources=` parses as an empty list, and never
        // depends on an empty argv element surviving the Windows cmd.exe shim.
        args.push(`--setting-sources=${sources.join(",")}`);
    }
    // --- consumer plugin dirs + memory (#27) ------------------------------
    const absList = (v, field) => {
        if (!Array.isArray(v))
            return [];
        const ok = v.filter((x) => typeof x === "string" && x !== "" && path.isAbsolute(x));
        if (ok.length !== v.length) {
            console.error(`[gryphon/claude-code] claudeCodeScope.${field}: ignored entries that aren't absolute paths`);
        }
        return ok;
    };
    const pluginDirs = absList(s.pluginDirs, "pluginDirs");
    if (pluginDirs.length > 0 && !hasFlag(extra, "--plugin-dir")) {
        for (const d of pluginDirs)
            args.push("--plugin-dir", d);
    }
    // Non-absolute memory entries pass through: the provider reports them as
    // missing, so a mistyped path is a visible Notice, not silently-lost rules.
    const memoryFiles = Array.isArray(s.memoryFiles) ? s.memoryFiles.filter((x) => typeof x === "string" && x !== "") : [];
    if (memoryFiles.length > 0 && hasFlag(extra, "--append-system-prompt-file")) {
        throw new Error("claudeCodeScope.memoryFiles can't be combined with an --append-system-prompt-file in extraArgs: " +
            "Claude Code keeps only the last one, so one set of rules would be dropped silently. Pass one or the other.");
    }
    // --- MCP allowlist ---------------------------------------------------
    // Default follows the setting-sources choice: inheriting user config
    // inherits the user's MCP servers too, unless the consumer says otherwise.
    // Every mode is strict (#27 Part B): Claude Code gets only the
    // --mcp-config we write from objects parsed once here.
    const mode = s.mcpServers !== undefined ? s.mcpServers : (s.inheritUserConfig === true ? "inherit" : "project");
    const vk = ctx.cwd ? mcpApprovals.vaultKey(ctx.cwd) : "";
    const settingsKeys = {};
    let servers = {};
    let pendingApprovals = [];
    let personal = [];
    if (mode === "inherit") {
        // Native precedence is local > project > user; a vault server still
        // needs an approval before it can shadow a personal one.
        const mine = readUserMcpServers(ctx.userConfigFile || defaultUserConfigFile(), ctx.cwd);
        if (mine.error)
            warnings.push(mine.error);
        const proj = readProjectMcpServers(ctx.cwd);
        if (proj.error)
            warnings.push(proj.error);
        const split = partitionVaultServers(proj.servers, vk, ctx.approvals, new Set(Object.keys(mine.local)));
        pendingApprovals = split.pending;
        servers = { ...mine.user, ...split.approved, ...mine.local };
        const approvedNames = new Set(Object.keys(split.approved));
        personal = Object.keys(servers).filter((n) => !approvedNames.has(n));
    }
    else {
        const consumer = mode && typeof mode === "object" ? mode : {};
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
    }
    if (!hasFlag(extra, "--strict-mcp-config"))
        args.push("--strict-mcp-config");
    const mcpServers = Object.keys(servers).length > 0 && !hasFlag(extra, "--mcp-config") ? servers : null;
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
        personalMcpServerNames: mcpServers ? personal : [],
        memoryFiles,
        summary: {
            settingSources: sources.join(","),
            strictMcp: true,
            mcpServerNames: Object.keys(mcpServers || {}),
            pendingApproval: pendingApprovals.map((p) => `${p.name} (${p.reason})`),
            autoMemory: typeof autoMemory === "boolean" ? autoMemory : "inherit",
            pluginDirs,
            memoryFiles,
        },
    };
}

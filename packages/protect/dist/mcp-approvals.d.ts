declare function isApprovableName(name: unknown): boolean;
interface ApprovalEntry {
    sha256: string;
    approvedAt: string;
}
interface ApprovalStore {
    version: number;
    vaults: Record<string, Record<string, ApprovalEntry>>;
}
interface LocateOpts {
    platform?: string;
    env?: Record<string, string | undefined>;
    homedir?: string;
}
declare function displaySafe(v: unknown): string;
declare function approvalsDir(opts?: LocateOpts): string;
declare function approvalsFilePath(opts?: LocateOpts): string;
declare function canonicalJSON(value: unknown): string;
declare function hashSpec(spec: unknown): string;
/**
 * The store key for a vault: its realpath, so a symlinked path to the same
 * vault shares approvals while a clone or a moved copy needs its own.
 */
declare function vaultKey(cwd: string): string;
/**
 * Read the store. Missing → empty. Unreadable / corrupt → empty AND a log
 * line: fail closed (nothing approved) rather than guess.
 */
declare function load(file?: string): ApprovalStore;
declare function isApproved(store: ApprovalStore, vk: string, name: string, specHash: string): boolean;
declare function listForVault(store: ApprovalStore, vk: string): Array<{
    name: string;
    sha256: string;
    approvedAt: string;
}>;
type ApprovalsTamperSink = (removed: Array<{
    vaultKey: string;
    name: string;
}>, error: unknown, info?: "record-started") => void;
/** Approvals added outside Gryphon and removed (or that couldn't be). */
declare function onApprovalsTamper(fn: ApprovalsTamperSink): () => void;
/** Mark a vault as served here before reading its approvals. */
declare function serveVault(vk: string): void;
declare function approve(vk: string, name: string, specHash: string, opts?: {
    file?: string;
    now?: Date;
}): void;
declare function revoke(vk: string, name: string, opts?: {
    file?: string;
}): void;
/**
 * The reader the provider injects into the scope resolver: re-reads the
 * file on every lookup, so an approval made in the modal applies on the
 * very next spawn with no cache to invalidate.
 */
declare function reader(opts?: {
    file?: string;
}): {
    lookup: (vk: string, name: string) => string | null;
};
/**
 * Extra directories guarded alongside `approvalsDir()` — issue #30: the
 * store-guard hook passes the dir Gryphon actually writes, so a tampered
 * XDG_CONFIG_HOME / APPDATA in the agent's environment can't move the
 * target away from it. Only ever widens what's guarded.
 */
type GuardOpts = LocateOpts & {
    extraDirs?: string[];
    /** Absolute ms time past which a check gives up and refuses (the hook's deadline). */
    deadlineAt?: number;
};
/**
 * True when `absPath` is the approval store's directory or anything inside
 * it. Case-insensitive (macOS / Windows filesystems are), and compared both
 * lexically and through symlinks so `/tmp` ↔ `/private/tmp` style aliases
 * don't slip past.
 */
declare function isApprovalsStorePath(absPath: string, opts?: GuardOpts): boolean;
/**
 * Shell commands that name the store. A best-effort lexical check, like
 * every other protected-command pattern: either store file's name anywhere
 * (`mcp-approvals.json`, and issue #29's `security-settings.json`), or the
 * store directory spelled any of the usual ways on each OS. It is NOT a
 * barrier against a model that already has a shell (see the header).
 */
declare const STORE_COMMAND_RE: RegExp;
declare function mentionsApprovalsStore(command: string, opts?: GuardOpts): boolean;
/** Argument names that may carry a target path, across CLIs and MCP tools. */
declare const PATH_ARG_RE: RegExp;
/** Names of a directory that relative path arguments may resolve against. */
declare const BASE_ARG_RE: RegExp;
declare function _isCommandKey(key: string): boolean;
/**
 * The string arguments of a tool call as `[key, value]` pairs, walked to a
 * bounded depth and count. An array of strings stays one entry under the
 * key that holds it (so `args: ["sh","-c","…"]` can be read as one command
 * line); an object's properties go under their own keys, so
 * `{edits: [{file_path}]}` reaches `file_path`. `truncated` is set when a
 * bound cut the walk short — the caller must not read that as "clean".
 */
declare function _argStrings(input: Record<string, unknown>, maxDepth: number, maxStrings: number): {
    pairs: Array<[string, string | string[]]>;
    truncated: boolean;
};
/**
 * A path argument → the absolute paths it could name: resolved against the
 * vault and against every cwd-like argument of the same call. `file:` URLs
 * are converted; any other `scheme:` value is still resolved as a path
 * (harmless for a real URL, and `ab:/../../…` is a relative path to a tool).
 */
declare function _resolveArgPaths(value: string, bases: string[]): string[];
declare function normalizeForMatch(s: unknown): string;
/**
 * Issue #30: the approvals-store rule as one pure function. `classify` and
 * the store-guard hook both call it, so the two can't disagree (A8).
 *
 * Returns `{ tool, what }` — the canonical tool name and a one-line
 * description of what matched — when the call writes, edits or runs a
 * command aimed at Gryphon's own trust stores; null otherwise. Read-only
 * tools are never matched. Any tool that isn't read-only or a shell is
 * walked for path-like and command-like arguments, nested ones included,
 * so a tool missing from TOOL_ALIASES can't write the store by default.
 *
 * `cwd` is the directory relative path arguments resolve against (the vault
 * for classify, the CLI's reported cwd for the hook). `extraDirs` widens
 * the guarded set (see GuardOpts). Depends only on node builtins and the
 * alias table, so it bundles into the standalone hook.
 */
declare function approvalsStoreVerdict(tool: string, input: Record<string, unknown> | null | undefined, opts?: GuardOpts & {
    cwd?: string | null;
}): {
    tool: string;
    what: string;
} | null;
export { onApprovalsTamper, serveVault, approvalsDir, approvalsFilePath, canonicalJSON, hashSpec, vaultKey, isApprovableName, displaySafe, load, isApproved, listForVault, approve, revoke, reader, isApprovalsStorePath, mentionsApprovalsStore, approvalsStoreVerdict, normalizeForMatch, _argStrings, _isCommandKey, _resolveArgPaths, PATH_ARG_RE, BASE_ARG_RE, STORE_COMMAND_RE, };

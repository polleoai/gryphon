declare const HOOK_SETTINGS_RE: RegExp;
declare const MCP_CONFIG_RE: RegExp;
declare const SOCKET_RE: RegExp;
declare const PROVENANCE_TMP_RE: RegExp;
declare const CHAT_HISTORY_TMP_RE: RegExp;
/**
 * Pid-liveness probe using signal 0. Returns true if a process with
 * the given pid is running (or exists under a different user — we
 * treat EPERM as "alive" defensively). False if ESRCH or pid is
 * nonsensical.
 */
declare function _isPidAlive(pid: number): boolean;
declare function sweepHookSettingsOrphans({ tmpDir, cutoffMs }?: {
    tmpDir?: string;
    cutoffMs?: number;
}): {
    removed: string[];
};
declare function sweepSocketOrphans({ tmpDir }?: {
    tmpDir?: string;
}): {
    removed: string[];
};
declare function sweepProvenanceTmpOrphans({ pluginDir, cutoffMs }?: {
    pluginDir?: string;
    cutoffMs?: number;
}): {
    removed: string[];
};
declare function sweepChatHistoryTmpOrphans({ pluginDir }?: {
    pluginDir?: string;
}): {
    removed: string[];
};
/**
 * Truncate the hook-trace log on plugin load when CLI debug logging
 * is on. Prevents cross-session accumulation so each reload starts
 * the trace log fresh — otherwise a long-running Obsidian with debug
 * on would build up unbounded trace lines.
 */
declare function truncateHookTraceLog({ tmpDir }?: {
    tmpDir?: string;
}): {
    truncated: boolean;
    path: string;
};
/**
 * One-stop sweeper. Call once at plugin onload. Returns a summary
 * object describing what was cleaned so the caller can log and tests
 * can assert.
 *
 * @param {object} opts
 *   pluginDir         — absolute path to the Gryphon plugin dir
 *   tmpDir            — override os.tmpdir() (tests)
 *   truncateTraceLog  — boolean; only truncate when devCliDebug is on
 */
declare function sweepGryphonOrphans(opts?: {
    pluginDir?: string;
    tmpDir?: string;
    truncateTraceLog?: boolean;
}): Record<string, unknown> & {
    hookSettings: {
        removed: string[];
    };
    sockets: {
        removed: string[];
    };
    provenanceTmp: {
        removed: string[];
    };
    chatHistoryTmp: {
        removed: string[];
    };
};
export { sweepGryphonOrphans, sweepHookSettingsOrphans, sweepSocketOrphans, sweepProvenanceTmpOrphans, sweepChatHistoryTmpOrphans, truncateHookTraceLog, _isPidAlive, HOOK_SETTINGS_RE, MCP_CONFIG_RE, SOCKET_RE, PROVENANCE_TMP_RE, CHAT_HISTORY_TMP_RE, };

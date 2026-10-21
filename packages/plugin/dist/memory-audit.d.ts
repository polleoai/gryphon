/**
 * F3 (v1.7.0) — auto-memory audit and archive helpers.
 *
 * Claude Code's auto-memory system loads everything under
 * `~/.claude/projects/<escaped-vault-path>/memory/MEMORY.md` (the index
 * file) plus on-demand pulls from sibling .md files in the same dir.
 * Active power users accumulate hundreds of memory files over months,
 * and the index frequently overflows CC's 24KB cap — the tail gets
 * silently truncated, which makes some prior context invisible to the
 * model.
 *
 * This module is the pure-logic substrate for the `/memory` modal in
 * chat-view: it finds the memory dir, lists files with `{name, size,
 * mtimeMs, ageDays, isCandidate}`, archives selected files to a
 * sibling `memory-archive/` directory (which CC does NOT scan), and
 * comments out the archived entries in `MEMORY.md` so the index stays
 * valid markdown but its dead references stop loading.
 */
interface MemoryFile {
    name: string;
    path: string;
    size: number;
    mtimeMs: number;
    ageDays: number;
}
interface MemoryMove {
    name: string;
    from: string;
    to: string;
}
interface MemoryIndexUpdate {
    commented: number;
    uncommented: number;
    indexWriteError?: string;
}
declare const MEMORY_INDEX_NAME = "MEMORY.md";
declare const ARCHIVE_DIRNAME = "memory-archive";
declare const DEFAULT_ARCHIVE_AGE_DAYS = 90;
declare function findMemoryDir({ vaultPath, homeDir }: {
    vaultPath?: unknown;
    homeDir?: unknown;
}): string | null;
declare function listMemoryFiles({ memoryDir, nowMs }: {
    memoryDir?: unknown;
    nowMs?: unknown;
}): MemoryFile[];
declare function classifyMemoryFiles(files: MemoryFile[] | null | undefined, { ageDaysThreshold }?: {
    ageDaysThreshold?: number;
}): {
    candidates: MemoryFile[];
    recent: MemoryFile[];
};
declare function archiveMemoryFiles({ memoryDir, files }: {
    memoryDir?: unknown;
    files?: Array<Partial<MemoryFile> | null | undefined> | null;
}): MemoryMove[];
declare function unarchiveMemoryFiles(moves: Array<Partial<MemoryMove> | null | undefined> | null | undefined): Array<{
    name: string | undefined;
}>;
declare function updateMemoryIndex({ memoryDir, archivedNames, restoredNames }: {
    memoryDir?: unknown;
    archivedNames?: unknown;
    restoredNames?: unknown;
}): MemoryIndexUpdate;
export { MEMORY_INDEX_NAME, ARCHIVE_DIRNAME, DEFAULT_ARCHIVE_AGE_DAYS, findMemoryDir, listMemoryFiles, classifyMemoryFiles, archiveMemoryFiles, unarchiveMemoryFiles, updateMemoryIndex, };

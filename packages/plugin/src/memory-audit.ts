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

import * as fs from "fs";
import * as path from "path";
import { escapeVaultPath } from "./context-budget";

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

const MEMORY_INDEX_NAME = "MEMORY.md";
const ARCHIVE_DIRNAME = "memory-archive";
const DEFAULT_ARCHIVE_AGE_DAYS = 90;

function findMemoryDir({ vaultPath, homeDir }: { vaultPath?: unknown; homeDir?: unknown }): string | null {
  if (typeof vaultPath !== "string" || !vaultPath) return null;
  if (typeof homeDir !== "string" || !homeDir) return null;
  const escaped = escapeVaultPath(vaultPath);
  const dir = path.join(homeDir, ".claude", "projects", escaped, "memory");
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return null;
    return dir;
  } catch {
    return null;
  }
}

function listMemoryFiles({ memoryDir, nowMs }: { memoryDir?: unknown; nowMs?: unknown }): MemoryFile[] {
  if (typeof memoryDir !== "string" || !memoryDir) return [];
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  let entries: string[];
  try {
    entries = fs.readdirSync(memoryDir);
  } catch {
    return [];
  }
  const out: MemoryFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    if (name.startsWith(".")) continue;
    const full = path.join(memoryDir, name);
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const ageDays = Math.max(0, Math.floor((now - st.mtimeMs) / (1000 * 60 * 60 * 24)));
    out.push({
      name,
      path: full,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ageDays,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function classifyMemoryFiles(
  files: MemoryFile[] | null | undefined,
  { ageDaysThreshold = DEFAULT_ARCHIVE_AGE_DAYS }: { ageDaysThreshold?: number } = {},
): { candidates: MemoryFile[]; recent: MemoryFile[] } {
  const candidates: MemoryFile[] = [];
  const recent: MemoryFile[] = [];
  for (const f of (files || [])) {
    if (f.name === MEMORY_INDEX_NAME) {
      recent.push(f);
      continue;
    }
    if (f.ageDays >= ageDaysThreshold) candidates.push(f);
    else recent.push(f);
  }
  return { candidates, recent };
}

function archiveMemoryFiles(
  { memoryDir, files }: { memoryDir?: unknown; files?: Array<Partial<MemoryFile> | null | undefined> | null },
): MemoryMove[] {
  if (typeof memoryDir !== "string" || !memoryDir) return [];
  if (!Array.isArray(files) || files.length === 0) return [];
  const archiveDir = path.join(memoryDir, ARCHIVE_DIRNAME);
  fs.mkdirSync(archiveDir, { recursive: true });
  const moved: MemoryMove[] = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string" || !f.path) continue;
    if (typeof f.name !== "string" || !f.name) continue;
    if (f.name === MEMORY_INDEX_NAME) continue;
    const dest = path.join(archiveDir, f.name);
    try {
      fs.renameSync(f.path, dest);
      moved.push({ name: f.name, from: f.path, to: dest });
    } catch {
      // Per-file move failure — skip and continue with remaining.
    }
  }
  return moved;
}

function unarchiveMemoryFiles(
  moves: Array<Partial<MemoryMove> | null | undefined> | null | undefined,
): Array<{ name: string | undefined }> {
  if (!Array.isArray(moves) || moves.length === 0) return [];
  const restored: Array<{ name: string | undefined }> = [];
  for (const m of moves) {
    if (!m || typeof m.from !== "string" || typeof m.to !== "string") continue;
    try {
      fs.renameSync(m.to, m.from);
      restored.push({ name: m.name });
    } catch {
      // Undo window expired or archive dir vanished — skip.
    }
  }
  return restored;
}

function updateMemoryIndex(
  { memoryDir, archivedNames, restoredNames }: { memoryDir?: unknown; archivedNames?: unknown; restoredNames?: unknown },
): MemoryIndexUpdate {
  if (typeof memoryDir !== "string" || !memoryDir) return { commented: 0, uncommented: 0 };
  const indexPath = path.join(memoryDir, MEMORY_INDEX_NAME);
  let text: string;
  try {
    text = fs.readFileSync(indexPath, "utf8");
  } catch {
    return { commented: 0, uncommented: 0 };
  }
  const lines = text.split("\n");
  const archivedSet = new Set<string>(Array.isArray(archivedNames) ? (archivedNames as string[]) : []);
  const restoredSet = new Set<string>(Array.isArray(restoredNames) ? (restoredNames as string[]) : []);
  let commented = 0;
  let uncommented = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wrappedMatch = /^<!--\s*\[gryphon-archived]\s*(.*?)\s*-->$/.exec(line);
    if (wrappedMatch) {
      const inner = wrappedMatch[1];
      if (_lineRefersToAny(inner, restoredSet)) {
        lines[i] = inner;
        uncommented += 1;
      }
      continue;
    }
    if (archivedSet.size > 0 && _lineRefersToAny(line, archivedSet)) {
      lines[i] = `<!-- [gryphon-archived] ${line} -->`;
      commented += 1;
    }
  }
  try {
    fs.writeFileSync(indexPath, lines.join("\n"));
  } catch (e: unknown) {
    const err = e as Error | null | undefined;
    // Index write failed — files are still moved on disk, but the
    // index still references them. CC will 404 those names on every
    // future turn until the user fixes the index manually or re-runs
    // /memory. Surface the error so the caller can Notice it; the
    // earlier "silent degradation" framing under-stated the impact.
    return {
      commented,
      uncommented,
      indexWriteError: (err && err.message) || String(err),
    };
  }
  return { commented, uncommented };
}

function _lineRefersToAny(line: unknown, nameSet: Set<string> | null | undefined): boolean {
  if (!nameSet || nameSet.size === 0) return false;
  if (typeof line !== "string" || !line) return false;
  for (const name of nameSet) {
    const bare = name.endsWith(".md") ? name.slice(0, -3) : name;
    if (line.includes(`(${name})`)) return true;
    if (line.includes(`[[${bare}]]`)) return true;
    if (line.includes(`[[${name}]]`)) return true;
  }
  return false;
}

export {
  MEMORY_INDEX_NAME,
  ARCHIVE_DIRNAME,
  DEFAULT_ARCHIVE_AGE_DAYS,
  findMemoryDir,
  listMemoryFiles,
  classifyMemoryFiles,
  archiveMemoryFiles,
  unarchiveMemoryFiles,
  updateMemoryIndex,
};

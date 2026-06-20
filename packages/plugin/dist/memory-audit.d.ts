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
export {};

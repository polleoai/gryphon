/**
 * Edit tool — exact-string replacement in an existing file.
 *
 * Mirrors Claude Code's Edit contract:
 *   - old_string must appear in the file (else error)
 *   - old_string must be unique (else error: "non-unique match")
 *   - replace_all=true bypasses the uniqueness check (replaces every
 *     occurrence; useful for renames)
 *
 * The exact-match contract forces the model to Read the file first to
 * get the actual content (whitespace, line endings, etc.). This is what
 * makes Edit safer than diff-based patches: there's no fuzzy matching to
 * silently apply the wrong change.
 *
 * Permission-gated like Write.
 */

const fs = require("fs");
const path = require("path");
const { resolveVaultPath, PathOutsideVaultError } = require("./path-utils");
const attackDetector = require("../../shared/attack-detector");

// See write.js for the platform rationale.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

// Matches Read's cap. `fs.readFileSync` on a 500 MB file allocates the
// buffer (+500 MB) AND the utf8 string (~another 500 MB) before our
// binary-sniff even runs — easy OOM on Obsidian's Electron renderer via
// a single prompt-injected Edit call. The user can override via
// Settings → Gryphon → Max file size (MB).
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;

function _maxFileSize(ctx) {
  const mb = ctx && ctx.plugin && ctx.plugin.settings &&
             Number(ctx.plugin.settings.maxReadFileSizeMb);
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return DEFAULT_MAX_FILE_SIZE;
}

// Extensions that are definitely not text. Mirrors Read's list plus a few
// binary container formats users commonly have in vaults (sqlite, dat, etc).
// This is a first-cut filter — the null-byte sniff below catches extensionless
// binary files too.
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".heic",
  ".pdf",
  ".mp3", ".mp4", ".m4a", ".mov", ".webm", ".mkv", ".wav", ".flac", ".ogg",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".bin", ".dat", ".exe", ".dmg", ".so", ".dll", ".o", ".a", ".class", ".jar",
  ".sqlite", ".sqlite3", ".db",
]);

const SCHEMA = {
  name: "Edit",
  description:
    "Performs exact string replacement in an existing file. The old_string " +
    "must match exactly (including whitespace) and must be unique unless " +
    "replace_all is true. Use Read first to see the current content.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path or path relative to the vault root.",
      },
      old_string: {
        type: "string",
        description: "Exact string to find. Must match including whitespace.",
      },
      new_string: {
        type: "string",
        description: "Replacement string. Must differ from old_string.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence (defaults to false).",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
};

// Maximum chars streamed into the diff preview. The modal's <pre> already
// has max-height + overflow: auto, so long diffs scroll — but multi-MB
// content would lag the render. 64 KB keeps any realistic edit visible in
// full while capping worst-case DOM load.
const MAX_DIFF_PREVIEW_CHARS = 64 * 1024;

async function execute(input, ctx) {
  const filePath = input.file_path;
  const oldString = input.old_string;
  const newString = input.new_string;
  const replaceAll = !!input.replace_all;

  if (typeof filePath !== "string" || !filePath) {
    return _error("Missing required parameter: file_path");
  }
  if (typeof oldString !== "string") {
    return _error("Missing required parameter: old_string (must be a string)");
  }
  if (typeof newString !== "string") {
    return _error("Missing required parameter: new_string (must be a string)");
  }
  if (oldString === newString) {
    return _error("old_string and new_string are identical — nothing to change.");
  }

  let resolved;
  try {
    resolved = resolveVaultPath(filePath, ctx.vaultRoot);
  } catch (e) {
    if (e instanceof PathOutsideVaultError) {
      return _error(`Path is outside the vault: ${filePath}.`);
    }
    return _error(String(e.message || e));
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    return _error(`File not found: ${filePath}. Use Write to create new files.`);
  }
  if (stat.isDirectory()) {
    return _error(`Path is a directory, not a file: ${filePath}`);
  }
  const maxSize = _maxFileSize(ctx);
  if (stat.size > maxSize) {
    const mb = (stat.size / 1024 / 1024).toFixed(1);
    const limitMb = maxSize / 1024 / 1024;
    return _error(
      `File too large to edit: ${filePath} is ${mb} MB (limit ${limitMb} MB). ` +
      `Edit loads the whole file into memory; for larger files, use Grep to ` +
      `locate the change site and then Write a targeted replacement if needed.`
    );
  }

  // Binary guard: reject known binary extensions up front, then sniff the
  // first 8 KB for null bytes (catches extensionless binaries like `.bin`
  // files without an extension, sqlite databases saved as `.data`, etc.).
  // UTF-8 round-tripping mangles non-ASCII bytes — without this guard, Edit
  // on a binary file succeeds and silently corrupts it.
  const ext = path.extname(resolved).toLowerCase();
  if (BINARY_EXTS.has(ext)) {
    return _error(
      `Cannot edit binary file (${ext}): ${filePath}. Edit only supports ` +
      `text files — a UTF-8 round-trip would corrupt binary content.`
    );
  }

  let rawBuf;
  try {
    rawBuf = fs.readFileSync(resolved);
  } catch (e) {
    return _error(`Failed to read file: ${e.message}`);
  }
  if (_looksBinary(rawBuf)) {
    return _error(
      `File appears to be binary (null bytes in the first 8 KB): ${filePath}. ` +
      `Edit only supports text files — a UTF-8 round-trip would corrupt binary content.`
    );
  }
  const original = rawBuf.toString("utf8");

  // Count occurrences for uniqueness check
  const occurrences = _countOccurrences(original, oldString);
  if (occurrences === 0) {
    return _error(
      `old_string not found in ${filePath}. Read the file to see its actual content — ` +
      `the string may have different whitespace or line endings than you expect.`
    );
  }
  if (occurrences > 1 && !replaceAll) {
    return _error(
      `old_string matches ${occurrences} places in ${filePath}. Either provide more ` +
      `context to make it unique, or set replace_all=true to replace every occurrence.`
    );
  }

  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString);

  const classification = attackDetector.classify(
    "Edit",
    { file_path: filePath, old_string: oldString, new_string: newString },
    ctx,
  );
  const perm = await attackDetector.gate(classification, {
    ctx,
    action: replaceAll ? `edit (${occurrences}x)` : "edit",
    target: filePath,
    detail: _buildDiffPreview(oldString, newString),
    kind: "fileEdit",
  });

  if (!perm.allow) return _error(perm.reason);

  // TOCTOU guard: re-read the file between approval and write. If it
  // changed while the user was deciding (another plugin, sync service,
  // manual edit in Obsidian), our `updated` string was computed from stale
  // content and writing it would silently discard the user's concurrent
  // changes.
  let current;
  try {
    current = fs.readFileSync(resolved, "utf8");
  } catch (e) {
    return _error(`Failed to re-read file before write: ${e.message}`);
  }
  if (current !== original) {
    return _error(
      `File changed during permission approval: ${filePath}. ` +
      `Another process modified it while the user was deciding. ` +
      `Re-read the file with Read and retry the edit against the current content.`
    );
  }

  const openFlags =
    fs.constants.O_WRONLY | fs.constants.O_TRUNC | O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(resolved, openFlags);
    fs.writeFileSync(fd, updated, "utf8");
  } catch (e) {
    if (e.code === "ELOOP" || e.code === "EMLINK") {
      return _error(
        `Refusing to follow a symlink at the edit target: ${filePath}. ` +
        `The file was replaced with a symlink during the edit.`
      );
    }
    return _error(`Failed to write file: ${e.message}`);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }

  return _ok(
    `Edited ${filePath}: replaced ${replaceAll ? `${occurrences} occurrences` : "1 occurrence"} ` +
    `(${oldString.length} → ${newString.length} chars per replacement)`
  );
}

function _looksBinary(buf) {
  // Null bytes are a reliable tell for binary formats — text files (UTF-8,
  // UTF-16 with BOM stripped, ASCII, most code) don't embed them. Scanning
  // the first 8 KB is enough to catch image/video headers and sqlite files.
  const sniffLen = Math.min(buf.length, 8192);
  for (let i = 0; i < sniffLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function _countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function _buildDiffPreview(oldString, newString) {
  // Show the full diff — the modal's <pre> scrolls, so there's no reason
  // to truncate to N lines and risk hiding malicious content past line N
  // that the user would approve without seeing. Cap at MAX_DIFF_PREVIEW_CHARS
  // only as a DOM-render safety net.
  const oldBlock = oldString.split("\n").map((l) => `- ${l}`).join("\n");
  const newBlock = newString.split("\n").map((l) => `+ ${l}`).join("\n");
  let preview = `--- old\n${oldBlock}\n\n+++ new\n${newBlock}`;
  if (preview.length > MAX_DIFF_PREVIEW_CHARS) {
    const elided = preview.length - MAX_DIFF_PREVIEW_CHARS;
    preview = preview.slice(0, MAX_DIFF_PREVIEW_CHARS) +
      `\n\n[truncated — ${elided} additional chars hidden; see full tool-use block in the chat log]`;
  }
  return preview;
}

function _ok(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function _error(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

module.exports = { SCHEMA, execute };

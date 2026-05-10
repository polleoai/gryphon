/**
 * Glob tool — recursive file matching against a glob pattern.
 *
 * Matches Claude Code's Glob behavior: returns file paths sorted by
 * modification time (newest first), capped at 250 entries by default.
 * Supports `**`, `*`, `?`, and `{a,b,c}` brace expansion.
 *
 * Implementation uses a minimal glob→regex translator (no extra deps).
 * For complex patterns we'd want picomatch, but the common cases
 * (`**\/*.md`, `src/**\/*.js`, `*.{ts,tsx}`) are well covered here.
 */

const fs = require("fs");
const path = require("path");
const { resolveVaultPath, PathOutsideVaultError } = require("@gryphon/protect");

const SCHEMA = {
  name: "Glob",
  description:
    "Fast file pattern matching that works with any codebase size. " +
    "Supports glob patterns like '**/*.js' or 'src/**/*.ts'. " +
    "Returns matching file paths sorted by modification time (newest first).",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match files against (e.g. '**/*.md').",
      },
      path: {
        type: "string",
        description: "The directory to search in. Defaults to the vault root.",
      },
    },
    required: ["pattern"],
  },
};

const DEFAULT_LIMIT = 250;
const MAX_DESCEND_ENTRIES = 50000;  // safety cap on directory walk

async function execute(input, ctx) {
  const pattern = input.pattern;
  if (!pattern) return _error("Missing required parameter: pattern");

  let searchRoot;
  try {
    searchRoot = input.path
      ? resolveVaultPath(input.path, ctx.vaultRoot)
      : ctx.vaultRoot;
  } catch (e) {
    if (e instanceof PathOutsideVaultError) {
      return _error(`Search path is outside the vault: ${input.path}`);
    }
    return _error(String(e.message || e));
  }

  let regex;
  try {
    regex = _globToRegex(pattern);
  } catch (e) {
    return _error(`Invalid glob pattern: ${e.message}`);
  }

  const matches = [];
  let walkedCount = 0;

  function walk(dir) {
    if (walkedCount >= MAX_DESCEND_ENTRIES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;  // unreadable dir — skip
    }
    for (const entry of entries) {
      walkedCount++;
      if (walkedCount >= MAX_DESCEND_ENTRIES) return;
      // Skip common noise directories that explode walk time
      if (entry.isDirectory() && _isIgnoredDir(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(ctx.vaultRoot, full);
      if (entry.isFile() && regex.test(rel)) {
        matches.push(full);
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  }

  walk(searchRoot);

  // Sort by mtime desc
  const withMtime = matches.map((p) => {
    let mtime = 0;
    try { mtime = fs.statSync(p).mtimeMs; } catch {}
    return { path: p, mtime };
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);

  const limited = withMtime.slice(0, DEFAULT_LIMIT);
  const text = limited.length === 0
    ? "(no files matched)"
    : limited.map((m) => m.path).join("\n") +
      (withMtime.length > DEFAULT_LIMIT
        ? `\n\n[showing first ${DEFAULT_LIMIT} of ${withMtime.length} matches; refine pattern to narrow]`
        : "");

  return _ok(text);
}

const IGNORED_DIRS = new Set([
  ".git", ".obsidian", "node_modules", ".venv", "venv",
  "__pycache__", ".pytest_cache", "dist", "build", ".next",
  ".kb-trash",
]);

function _isIgnoredDir(name) {
  return IGNORED_DIRS.has(name) || name.startsWith(".cache");
}

/**
 * Convert a glob pattern to a RegExp.
 * Handles: **, *, ?, character classes [abc], braces {a,b,c}.
 *
 * Anchored to full-string match.
 */
function _globToRegex(glob) {
  // First expand braces: foo.{js,ts} → (foo.js|foo.ts)
  const expanded = _expandBraces(glob);
  if (expanded.length > 1) {
    const sub = expanded.map(_singleGlobToRegexBody).join("|");
    return new RegExp("^(?:" + sub + ")$");
  }
  return new RegExp("^" + _singleGlobToRegexBody(expanded[0]) + "$");
}

function _expandBraces(glob) {
  const m = glob.match(/^(.*?)\{([^{}]+)\}(.*)$/);
  if (!m) return [glob];
  const [, before, inner, after] = m;
  const options = inner.split(",");
  const out = [];
  for (const opt of options) {
    out.push(...(_expandBraces(before + opt + after)));
  }
  return out;
}

function _singleGlobToRegexBody(glob) {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators (zero or more chars)
        out += ".*";
        i += 2;
        // Eat trailing slash so `**/foo` matches `foo` too
        if (glob[i] === "/") i++;
      } else {
        // * matches anything except path separator
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "[") {
      // pass through character class
      const end = glob.indexOf("]", i + 1);
      if (end < 0) {
        out += "\\[";
        i++;
      } else {
        out += glob.substring(i, end + 1);
        i = end + 1;
      }
    } else if (/[.+()|^$\\]/.test(c)) {
      out += "\\" + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function _ok(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function _error(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

// Internal helpers exported for testing. Not part of the public tool
// API — direct callers should use execute() which orchestrates path
// validation, walking, and result formatting.
module.exports = { SCHEMA, execute, _globToRegex, _expandBraces };

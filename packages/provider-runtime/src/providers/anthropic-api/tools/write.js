/**
 * Write tool — full-file write (creates or overwrites).
 *
 * Mirrors Claude Code's Write contract. Creates parent directories
 * automatically. Permission-gated: refuses in plan mode, prompts in
 * default mode, auto-allows in acceptEdits / bypassPermissions.
 *
 * Safety: path resolves through resolveVaultPath (vault-only). Never
 * touches files outside the vault, even with bypassPermissions.
 */

const fs = require("fs");
const path = require("path");
const { resolveVaultPath, PathOutsideVaultError } = require("@gryphon/protect");
const { attackDetector } = require("@gryphon/protect");

// On Linux/macOS, `O_NOFOLLOW` tells the kernel to refuse the open if the
// final path component is a symlink — closing the last TOCTOU sliver where
// an attacker swaps the leaf between our resolveVaultPath re-check and
// the actual write. On Windows, the flag is undefined; we fall through
// to no extra protection there (Windows symlinks require admin by default
// so the local-attacker threat model is much weaker).
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

const SCHEMA = {
  name: "Write",
  description:
    "Writes a file to the local filesystem. Overwrites existing files. " +
    "Creates parent directories as needed. Use Edit instead for targeted " +
    "changes to existing files.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path or path relative to the vault root.",
      },
      content: {
        type: "string",
        description: "The full content to write to the file.",
      },
    },
    required: ["file_path", "content"],
  },
};

const MAX_PREVIEW_LINES = 30;

async function execute(input, ctx) {
  const filePath = input.file_path;
  const content = input.content;

  if (typeof filePath !== "string" || !filePath) {
    return _error("Missing required parameter: file_path");
  }
  if (typeof content !== "string") {
    return _error("Missing required parameter: content (must be a string)");
  }

  let resolved;
  try {
    resolved = resolveVaultPath(filePath, ctx.vaultRoot);
  } catch (e) {
    if (e instanceof PathOutsideVaultError) {
      return _error(`Path is outside the vault: ${filePath}. SDK-mode tools can only write within the vault.`);
    }
    return _error(String(e.message || e));
  }

  // Refuse to overwrite a directory
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return _error(`Path is a directory, not a file: ${filePath}`);
  }

  const exists = fs.existsSync(resolved);
  const previewLines = content.split("\n").slice(0, MAX_PREVIEW_LINES);
  const previewText = previewLines.join("\n") +
    (content.split("\n").length > MAX_PREVIEW_LINES ? "\n…" : "");

  const classification = attackDetector.classify("Write", { file_path: filePath, content }, ctx);
  const perm = await attackDetector.gate(classification, {
    ctx,
    action: exists ? "overwrite" : "create",
    target: filePath,
    detail: `${exists ? "Overwriting existing file" : "Creating new file"}\n` +
            `Path: ${resolved}\n` +
            `Bytes: ${Buffer.byteLength(content, "utf8")}\n` +
            `\n--- preview (first ${MAX_PREVIEW_LINES} lines) ---\n` +
            previewText,
    kind: "fileEdit",
  });

  if (!perm.allow) return _error(perm.reason);

  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  } catch (e) {
    return _error(`Failed to create parent directory: ${e.message}`);
  }

  // Re-validate after mkdir. `mkdirSync` with `recursive: true` silently
  // traverses symlinks as it walks the path — if an attacker with vault
  // write access replaced a component with a symlink between the initial
  // resolveVaultPath() above and mkdirSync just now, we'd now be about
  // to writeFileSync outside the vault. Re-resolving the dirname forces
  // realpath to run against the post-mkdir filesystem state.
  try {
    resolveVaultPath(path.dirname(resolved), ctx.vaultRoot);
  } catch {
    return _error(
      `Path escaped the vault between resolution and mkdir: ${filePath}. ` +
      `Aborting before write.`
    );
  }

  // Open the leaf with O_NOFOLLOW — if an attacker swapped the file for a
  // symlink between the resolveVaultPath re-check above and here, the
  // kernel refuses the open (ELOOP) instead of following the link.
  const openFlags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(resolved, openFlags, 0o644);
    fs.writeFileSync(fd, content, "utf8");
  } catch (e) {
    if (e.code === "ELOOP" || e.code === "EMLINK") {
      return _error(
        `Refusing to follow a symlink at the write target: ${filePath}. ` +
        `The file was replaced with a symlink during the write.`
      );
    }
    return _error(`Failed to write file: ${e.message}`);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }

  return _ok(
    `${exists ? "Updated" : "Created"} ${filePath} (${Buffer.byteLength(content, "utf8")} bytes, ${content.split("\n").length} lines)`
  );
}

function _ok(text) {
  return { content: [{ type: "text", text }], isError: false };
}

function _error(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

module.exports = { SCHEMA, execute };

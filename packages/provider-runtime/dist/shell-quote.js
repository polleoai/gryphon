"use strict";
// TypeScript module marker.
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Quoting for hook commands that a CLI hands to a shell (R43-1).
 *
 * Hook command strings embed the node binary and a hook script path, and
 * the script path sits under the VAULT folder, which whoever made the vault
 * named. JSON.stringify is not shell quoting: inside double quotes sh still
 * expands `$(...)`, backticks and `$VAR`, so a vault named `v$(cmd)` ran
 * `cmd` on every hook call. On Windows an unescaped `'` (a legal filename
 * character, as in "Bob's Vault") ended the literal and broke every hook,
 * which the CLIs treat as allow.
 */
/**
 * POSIX single-quote: everything inside is literal to sh (no $, backtick or
 * backslash expansion), and shlex-style splitters read it the same way.
 */
function shQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
/**
 * PowerShell single-quote: literal. PowerShell also treats the typographic
 * single quotes U+2018/U+2019/U+201A/U+201B as quote characters, so each of
 * those is doubled too (a path like `O’Brien` must not end the literal).
 */
function psQuote(s) {
    return `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;
}
/** `node script` as one shell command line for `platform`. */
function hookCommandLine(nodePath, scriptPath, platform = process.platform) {
    if (platform === "win32")
        return `& ${psQuote(nodePath)} ${psQuote(scriptPath)}`;
    return `${shQuote(nodePath)} ${shQuote(scriptPath)}`;
}
module.exports = { shQuote, psQuote, hookCommandLine };

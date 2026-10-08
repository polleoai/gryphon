"use strict";
// TypeScript module marker.
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * The hook command for store-guard-only mode (issue #30), shared by the
 * codex / gemini / antigravity adapters.
 *
 * The dialect and the guarded approvals dir are passed as ARGUMENTS baked
 * into the command string, never inherited from the CLI's environment: a
 * dialect lost on the way to the hook makes it answer in a shape the CLI
 * can't read, and several CLIs treat that as allow. Arguments survive every
 * shell the CLIs use (sh, PowerShell, a .cmd shim) without per-shell env
 * syntax.
 */
/**
 * POSIX single-quote: everything inside is literal to sh (no $, backtick or
 * backslash expansion), and shlex-style splitters read it the same way.
 */
function shQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
/** PowerShell single-quote: literal; an embedded ' is doubled. */
function psQuote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}
/** Seconds — the decision is immediate; this only bounds a stuck stdin. */
const STORE_GUARD_TIMEOUT_S = 30;
function storeGuardArgv({ nodePath, scriptPath, approvalsDir, dialect }) {
    return [nodePath, scriptPath, dialect, approvalsDir];
}
/** `{ command, shell? }` for a CLI that runs hook commands through a shell. */
function storeGuardCommand(opts, platform = process.platform) {
    const argv = storeGuardArgv(opts);
    if (platform === "win32") {
        const [exe, ...rest] = argv.map(psQuote);
        return { command: `& ${exe} ${rest.join(" ")}`, shell: "powershell" };
    }
    return { command: argv.map(shQuote).join(" ") };
}
module.exports = { shQuote, psQuote, storeGuardArgv, storeGuardCommand, STORE_GUARD_TIMEOUT_S };

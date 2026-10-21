"use strict";
// TypeScript module marker.
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORE_GUARD_TIMEOUT_S = exports.psQuote = exports.shQuote = void 0;
exports.storeGuardArgv = storeGuardArgv;
exports.storeGuardCommand = storeGuardCommand;
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
// Shared with every hook-command builder (R43-1): one quoting
// implementation, including PowerShell's typographic single quotes.
const shell_quote_1 = require("@polleoai/gryphon-provider-runtime/shell-quote");
Object.defineProperty(exports, "shQuote", { enumerable: true, get: function () { return shell_quote_1.shQuote; } });
Object.defineProperty(exports, "psQuote", { enumerable: true, get: function () { return shell_quote_1.psQuote; } });
/** Seconds — the decision is immediate; this only bounds a stuck stdin. */
const STORE_GUARD_TIMEOUT_S = 30;
exports.STORE_GUARD_TIMEOUT_S = STORE_GUARD_TIMEOUT_S;
function storeGuardArgv({ nodePath, scriptPath, approvalsDir, dialect }) {
    return [nodePath, scriptPath, dialect, approvalsDir];
}
/** `{ command, shell? }` for a CLI that runs hook commands through a shell. */
function storeGuardCommand(opts, platform = process.platform) {
    const argv = storeGuardArgv(opts);
    if (platform === "win32") {
        const [exe, ...rest] = argv.map(shell_quote_1.psQuote);
        return { command: `& ${exe} ${rest.join(" ")}`, shell: "powershell" };
    }
    return { command: argv.map(shell_quote_1.shQuote).join(" ") };
}

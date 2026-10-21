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
import { shQuote, psQuote } from "@polleoai/gryphon-provider-runtime/shell-quote";
/** Seconds — the decision is immediate; this only bounds a stuck stdin. */
declare const STORE_GUARD_TIMEOUT_S = 30;
declare function storeGuardArgv({ nodePath, scriptPath, approvalsDir, dialect }: {
    nodePath: string;
    scriptPath: string;
    approvalsDir: string;
    dialect: string;
}): string[];
/** `{ command, shell? }` for a CLI that runs hook commands through a shell. */
declare function storeGuardCommand(opts: {
    nodePath: string;
    scriptPath: string;
    approvalsDir: string;
    dialect: string;
}, platform?: string): {
    command: string;
    shell?: string;
};
export { shQuote, psQuote, storeGuardArgv, storeGuardCommand, STORE_GUARD_TIMEOUT_S };

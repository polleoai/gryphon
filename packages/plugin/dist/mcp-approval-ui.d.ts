/**
 * Vault MCP server approval UX (issue #25, Design rev 2).
 *
 * The claude-code provider leaves out every vault `.mcp.json` server that no
 * out-of-vault approval matches, and hands the list to the host through
 * `hostAdapter.mcpApprovalsPending`. This module is that host side:
 *
 *   - a Notice ("…haven't been approved. They won't run.") with a Review
 *     button — once per (vault, name, spec hash) per Obsidian session;
 *   - the review modal: each server's full command line (or URL), cwd, and
 *     env / header values (masked only when the key looks secret), marked
 *     new or changed, with Approve per server and Not now;
 *   - Settings → Advanced → "Approved vault MCP servers" with Revoke.
 *
 * Approve / revoke write the store in the user profile (never the vault)
 * and bump `plugin.mcpApprovalsGeneration`, which is part of the chat's
 * spawn signature — the next message respawns with --resume under the new
 * server set. The approval is for the hash that was SHOWN: if the file
 * changes between review and click, the new spec simply isn't approved.
 */
import type { App, Setting as SettingType } from "obsidian";
interface PendingApproval {
    name: string;
    spec: unknown;
    specHash: string;
    reason: "new" | "changed";
}
interface PendingReport {
    cwd?: string;
    vaultKey: string;
    pending: PendingApproval[];
}
/** The slice of the plugin instance this module reads and writes. */
interface ApprovalPluginHost {
    app?: App;
    mcpApprovalsGeneration?: number;
    _mcpApprovalNoticesSeen?: Set<string>;
}
/**
 * Human-readable view of a server spec for the approval modal. Env / header
 * values are shown unless the key looks secret (and isn't a `${VAR}`
 * reference); a value that changes what runs is always shown and flagged.
 * Adds a Warning row when the command runs code from inside the vault —
 * editing that code later does NOT invalidate the approval, which covers
 * the spec, not the files it points at. Every value is `_clean`ed.
 */
declare function describeServer(spec: unknown, vaultDir?: string | null): Array<[string, string]>;
/**
 * The entries not yet announced this session, recording them as announced.
 * Keyed on the spec hash, so an edited server is announced again.
 */
declare function takeUnannounced(seen: Set<string>, vaultKey: string, pending: PendingApproval[]): PendingApproval[];
/** Host hook for the provider: Notice with a Review action. */
declare function handlePendingApprovals(plugin: ApprovalPluginHost, report: PendingReport): void;
declare function openReviewModal(plugin: ApprovalPluginHost, report: PendingReport): void;
/** Settings → Advanced: this vault's approvals, each with Revoke. */
declare function renderApprovedServersSetting(plugin: ApprovalPluginHost, panelEl: HTMLElement, descToTooltip: (s: SettingType, t: string) => unknown): void;
export { describeServer, takeUnannounced, handlePendingApprovals, openReviewModal, renderApprovedServersSetting, };

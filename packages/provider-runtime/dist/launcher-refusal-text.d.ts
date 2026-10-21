/**
 * QA (2.11.2): the plain cause and the fix for each reason Gryphon refuses
 * to build Antigravity's Windows hook launcher. One table, used by every
 * notice that can report it — the dispatcher's two notices and the
 * Antigravity provider's refusal — so they never disagree or fall back to
 * "check hooks.json" when that isn't the problem.
 */
type RefusalText = {
    cause: string;
    fix: string;
};
/** The cause and fix for a launcher refusal named in `reason`, or null. */
declare function launcherRefusalText(reason: string | null | undefined): RefusalText | null;
export { launcherRefusalText };

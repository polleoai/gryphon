/**
 * Cross-CLI tool-name aliases. Different CLIs name the same tool
 * differently — Claude Code's "Bash" is Gemini's "run_shell_command",
 * Codex's "command_execution", and so on. The classifier internally
 * speaks Claude Code's tool vocabulary (Bash / Write / Edit /
 * PowerShell), so we normalize incoming names before dispatching.
 *
 * Adding a new CLI = add its tool names here. The classifier itself
 * stays vocabulary-pure.
 */
declare const TOOL_ALIASES: Record<string, string>;
/** Every path a patch names, and whether the scan had to stop early. */
declare function patchTargetsInfo(input: unknown): {
    targets: string[];
    truncated: boolean;
};
declare function patchTargets(input: unknown): string[];
/**
 * Directories a shell command may `cd`/`pushd` into before patching, read
 * lexically (quotes removed). Used only as EXTRA bases for resolving a
 * patch's relative paths, so a miss here can't loosen anything.
 */
declare const MAX_CD_DIRS = 256;
declare function shellCdDirs(command: unknown): string[];
export { TOOL_ALIASES, patchTargets, patchTargetsInfo, shellCdDirs, MAX_CD_DIRS };

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
interface WriteInput {
    file_path?: unknown;
    content?: unknown;
}
type WriteToolContext = {
    vaultRoot: string;
    [key: string]: unknown;
};
declare const SCHEMA: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            file_path: {
                type: string;
                description: string;
            };
            content: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
declare function execute(input: WriteInput, ctx: WriteToolContext): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    isError: boolean;
}>;
export { SCHEMA, execute };

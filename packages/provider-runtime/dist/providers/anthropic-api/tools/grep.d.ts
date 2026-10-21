/**
 * Grep tool — content search across files using a regex pattern.
 *
 * Mirrors Claude Code's Grep but implemented in pure Node (no ripgrep
 * dependency). For very large vaults this will be slower than rg —
 * acceptable tradeoff for Anthropic API mode where we need pure-JS portability.
 *
 * Output modes:
 *   "content"            — matching lines with line numbers (default)
 *   "files_with_matches" — paths only, one per line
 *   "count"              — match count per file
 */
interface GrepInput {
    pattern?: string;
    path?: string;
    glob?: string;
    output_mode?: string;
    "-i"?: boolean;
    "-n"?: boolean;
    head_limit?: number | string;
}
interface GrepToolContext {
    vaultRoot: string;
}
declare const SCHEMA: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            pattern: {
                type: string;
                description: string;
            };
            path: {
                type: string;
                description: string;
            };
            glob: {
                type: string;
                description: string;
            };
            output_mode: {
                type: string;
                enum: string[];
                description: string;
            };
            "-i": {
                type: string;
                description: string;
            };
            "-n": {
                type: string;
                description: string;
            };
            head_limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
declare function execute(input: GrepInput, ctx: GrepToolContext): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    isError: boolean;
}>;
export { SCHEMA, execute };

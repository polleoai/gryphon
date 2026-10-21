/**
 * Read tool — returns file contents with optional line offset/limit.
 *
 * Schema mirrors Claude Code's built-in Read tool so model behavior is
 * consistent across CLI and Anthropic API modes. Output format also mirrors CC's
 * (line-numbered with `cat -n` style) — the model has been trained on
 * this format, so reproducing it gives better tool-use behavior.
 */
interface ReadInput {
    file_path: string;
    offset?: number | string;
    limit?: number | string;
}
interface ReadToolContext {
    vaultRoot: string;
    plugin?: {
        settings?: {
            maxReadFileSizeMb?: unknown;
        };
    } | null;
}
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
            offset: {
                type: string;
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
declare function execute(input: ReadInput, ctx: ReadToolContext): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    isError: boolean;
}>;
export { SCHEMA, execute };

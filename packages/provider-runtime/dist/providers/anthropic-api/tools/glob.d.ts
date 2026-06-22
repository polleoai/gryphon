/**
 * Glob tool — recursive file matching against a glob pattern.
 *
 * Matches Claude Code's Glob behavior: returns file paths sorted by
 * modification time (newest first), capped at 250 entries by default.
 * Supports `**`, `*`, `?`, and `{a,b,c}` brace expansion.
 *
 * Implementation uses a minimal glob→regex translator (no extra deps).
 * For complex patterns we'd want picomatch, but the common cases
 * (`**\/*.md`, `src/**\/*.js`, `*.{ts,tsx}`) are well covered here.
 */
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
        };
        required: string[];
    };
};
declare function execute(input: any, ctx: any): Promise<{
    content: {
        type: string;
        text: any;
    }[];
    isError: boolean;
}>;
/**
 * Convert a glob pattern to a RegExp.
 * Handles: **, *, ?, character classes [abc], braces {a,b,c}.
 *
 * Anchored to full-string match.
 */
declare function _globToRegex(glob: any): RegExp;
declare function _expandBraces(glob: any): string[];
export { SCHEMA, execute, _globToRegex, _expandBraces };

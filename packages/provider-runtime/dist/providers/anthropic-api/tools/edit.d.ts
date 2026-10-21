/**
 * Edit tool — exact-string replacement in an existing file.
 *
 * Mirrors Claude Code's Edit contract:
 *   - old_string must appear in the file (else error)
 *   - old_string must be unique (else error: "non-unique match")
 *   - replace_all=true bypasses the uniqueness check (replaces every
 *     occurrence; useful for renames)
 *
 * The exact-match contract forces the model to Read the file first to
 * get the actual content (whitespace, line endings, etc.). This is what
 * makes Edit safer than diff-based patches: there's no fuzzy matching to
 * silently apply the wrong change.
 *
 * Permission-gated like Write.
 */
interface EditInput {
    file_path?: unknown;
    old_string?: unknown;
    new_string?: unknown;
    replace_all?: unknown;
}
type EditToolContext = {
    vaultRoot: string;
    plugin?: {
        settings?: {
            maxReadFileSizeMb?: unknown;
        };
    } | null;
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
            old_string: {
                type: string;
                description: string;
            };
            new_string: {
                type: string;
                description: string;
            };
            replace_all: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
declare function execute(input: EditInput, ctx: EditToolContext): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    isError: boolean;
}>;
export { SCHEMA, execute };

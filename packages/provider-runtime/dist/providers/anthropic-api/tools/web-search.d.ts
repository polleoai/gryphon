declare const SCHEMA: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            query: {
                type: string;
                description: string;
            };
            max_results: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
interface WebSearchInput {
    query?: unknown;
    max_results?: number | string;
}
interface HostResponse {
    status: number;
    json?: unknown;
    text?: unknown;
}
interface WebSearchHostAdapter {
    fetch(url: string, opts: {
        method: string;
        headers: Record<string, string>;
        throw: boolean;
    }): Promise<HostResponse>;
}
interface WebSearchToolContext {
    permissionMode?: string;
    plugin?: {
        settings?: {
            braveSearchApiKey?: string;
        };
    } | null;
    hostAdapter: WebSearchHostAdapter;
}
declare function execute(input: WebSearchInput, ctx: WebSearchToolContext): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    isError: boolean;
}>;
export { SCHEMA, execute };

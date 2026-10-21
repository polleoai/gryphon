/**
 * WebFetch tool — fetch a URL and return its content.
 *
 * Mirrors Claude Code's WebFetch contract. Returns up to MAX_CONTENT_BYTES
 * of decoded body. For HTML, performs minimal cleanup (strip <script>,
 * <style>, collapse whitespace) so the model gets readable text rather
 * than raw markup. PDF / binary content surfaces as an error directing
 * the model to use Read on a local copy if needed.
 *
 * Permission: read-only network operation. Refused only in plan mode;
 * allowed in default / acceptEdits / bypassPermissions without prompt.
 *
 * SSRF hardening:
 *   - The URL's hostname is refused if it is a private / loopback /
 *     link-local literal, or if DNS resolves it to one (checked before the
 *     request).
 *   - Headless hosts (HeadlessHostAdapter → nodeFetch) also get
 *     `blockAddress`: every redirect hop's hostname and every address DNS
 *     resolves it to are checked at connect time, so a redirect to an
 *     internal address and DNS rebinding are both refused.
 *   - Known gap (Obsidian): requestUrl follows redirects itself and ignores
 *     `blockAddress`, so there a redirect hop to a private address isn't
 *     re-checked and the connection isn't pinned to the checked address.
 */
declare const SCHEMA: {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: {
            url: {
                type: string;
                description: string;
            };
            prompt: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
interface WebFetchInput {
    url?: unknown;
    prompt?: string;
}
interface HostResponse {
    status: number;
    headers?: Record<string, string>;
    text?: unknown;
    arrayBuffer?: ArrayBuffer;
}
interface WebFetchHostAdapter {
    fetch(url: string, opts: {
        method: string;
        headers: Record<string, string>;
        throw: boolean;
        blockAddress?: (hostOrIp: string) => boolean;
    }): Promise<HostResponse>;
}
interface WebFetchToolContext {
    permissionMode?: string;
    hostAdapter: WebFetchHostAdapter;
}
declare function execute(input: WebFetchInput, ctx: WebFetchToolContext): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    isError: boolean;
}>;
declare function _isPrivateHost(hostname: string | null | undefined): boolean;
declare function _isAllowedContentType(contentType: string | null | undefined): boolean;
export { SCHEMA, execute, _isPrivateHost, _isAllowedContentType };

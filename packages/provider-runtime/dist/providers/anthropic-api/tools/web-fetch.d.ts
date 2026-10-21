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
 *   - The request carries `blockAddress`, and both host adapters send it
 *     through nodeFetch (Obsidian's too: requestUrl would follow redirects
 *     unchecked, #40). Every redirect hop's hostname and every address DNS
 *     resolves it to are checked at connect time, so a redirect to an
 *     internal address and DNS rebinding are both refused; through a proxy,
 *     the proxy is sent the checked address.
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
        timeoutMs?: number;
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

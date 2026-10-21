/** The response surface callers use (nodeFetch and a WHATWG Response both satisfy it). */
interface FetchResponse {
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
}
/** A fetch-like function; the default is nodeFetch (node http/https). */
type FetchImpl = (url: string, opts?: RequestInit) => Promise<FetchResponse>;
declare class HeadlessHostAdapter {
    private readonly _fetchImpl;
    /** `fetchImpl` replaces the default fetch (embedders with their own client, tests). */
    constructor(options?: {
        fetchImpl?: FetchImpl;
    });
    notify(message: string, opts?: {
        level?: string;
        timeoutMs?: number;
    }): void;
    fetch(url: string, opts?: RequestInit): Promise<FetchResponse>;
}
export { HeadlessHostAdapter };

/**
 * Read a host adapter's fetch response, whichever shape it has.
 *
 * ObsidianHostAdapter returns Obsidian's requestUrl shape — `text` (string) and
 * `json` (parsed) as properties. HeadlessHostAdapter (nodeFetch) and any
 * WHATWG-style fetch return `text()` / `json()` methods. Tools must handle
 * both, or a headless run reads an empty body as if the page were blank.
 */
interface HostBody {
    text?: unknown;
    json?: unknown;
    arrayBuffer?: unknown;
}
declare function readText(res: HostBody): Promise<string>;
/** Parsed JSON body, or undefined when there is none or it doesn't parse. */
declare function readJson(res: HostBody): Promise<unknown>;
export { readText, readJson };

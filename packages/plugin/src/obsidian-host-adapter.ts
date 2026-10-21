import { Notice, requestUrl } from "obsidian";
import { nodeFetch, proxyFromEnv } from "@polleoai/gryphon-provider-runtime/node-fetch";
/**
 * ObsidianHostAdapter — wraps Obsidian's Notice + requestUrl behind
 * the HostAdapter duck-type so runtime/protect can stay headless.
 *
 * The plugin instantiates one and passes it to createProvider() and
 * createProtectionContext() so internals never `require("obsidian")` directly.
 */

interface HostAdapterHooks {
  onMcpApprovalsPending?: (report: unknown) => void;
}

interface NotifyOpts {
  level?: string;
  timeoutMs?: number;
}

interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  /** Socket idle limit for a guarded request. */
  timeoutMs?: number;
  /** SSRF guard; when set, the request goes through nodeFetch (see fetch()). */
  blockAddress?: (hostOrIp: string) => boolean;
}

/** Network failures a direct connection gets on a network that only allows a proxy. */
const DIRECT_FAILURE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * A guarded fetch that couldn't connect directly, with no proxy configured,
 * says how to configure one — Obsidian's own proxy settings don't apply to it.
 */
function _withProxyHint(e: unknown, url: string, proxyFor: (target: URL) => string | null): unknown {
  const err = e as NodeJS.ErrnoException;
  if (!err || !DIRECT_FAILURE_CODES.has(err.code || "")) return e;
  let proxied = false;
  try { proxied = proxyFor(new URL(url)) !== null; } catch { return e; }
  if (proxied) return e;
  return new Error(
    `${err.message}. If your network only allows web access through a proxy, set HTTPS_PROXY ` +
    `(and HTTP_PROXY / NO_PROXY) in the environment Obsidian starts in.`,
  );
}

class ObsidianHostAdapter {
  declare mcpApprovalsPending?: (report: unknown) => void;

  /**
   * @param {object} [hooks]
   * @param {Function} [hooks.onMcpApprovalsPending] — issue #25 rev 2: the
   *   claude-code provider left out vault MCP servers nobody approved; the
   *   plugin shows the Notice + review modal (see mcp-approval-ui.ts).
   */
  constructor(hooks?: HostAdapterHooks) {
    // Defined only when wired, so the provider's plain-Notice fallback
    // applies to an adapter built without the hook.
    const onPending = hooks && hooks.onMcpApprovalsPending;
    if (typeof onPending === "function") this.mcpApprovalsPending = (report: unknown) => onPending(report);
  }

  notify(message: string, opts?: NotifyOpts) {
    opts = opts || {};
    // opts.level (info|warn|error) is accepted for HostAdapter contract parity but
    // ignored — Obsidian's Notice has no severity surface. Headless paths route by
    // level via console.error/warn/log; here every notice renders identically.
    new Notice(message, opts.timeoutMs || 5000);
  }

  async fetch(url: string, opts?: FetchOpts) {
    opts = opts || {};
    if (opts.blockAddress) {
      // A guarded request (WebFetch) can't use requestUrl: it follows
      // redirects itself and connects to whatever the name resolves to then,
      // so a redirect or a rebinding name reaches an internal address (#40).
      // nodeFetch checks every hop and connects only to checked addresses.
      // requestUrl's system proxy isn't available to it, so the proxy comes
      // from HTTPS_PROXY / HTTP_PROXY / NO_PROXY instead.
      const body = opts.body instanceof ArrayBuffer ? new Uint8Array(opts.body) : opts.body;
      const proxyFor = proxyFromEnv(process.env);
      try {
        return await nodeFetch(url, {
          method: opts.method || "GET",
          headers: opts.headers,
          body,
          timeoutMs: opts.timeoutMs,
          blockAddress: opts.blockAddress,
          proxyFor,
        });
      } catch (e) {
        throw _withProxyHint(e, url, proxyFor);
      }
    }
    const response = await requestUrl({
      url,
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body,
      throw: false,
    });
    // Normalise to a fetch-like shape so callers can write provider-agnostic code.
    return {
      status: response.status,
      text: async () => response.text,
      json: async () => response.json as unknown,
    };
  }
}

export { ObsidianHostAdapter };

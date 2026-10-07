/**
 * Vault MCP server approval UX (issue #25, Design rev 2).
 *
 * The claude-code provider leaves out every vault `.mcp.json` server that no
 * out-of-vault approval matches, and hands the list to the host through
 * `hostAdapter.mcpApprovalsPending`. This module is that host side:
 *
 *   - a Notice ("…haven't been approved. They won't run.") with a Review
 *     button — once per (vault, name, spec hash) per Obsidian session;
 *   - the review modal: each server's full command line (or URL), cwd, and
 *     env / header values (masked only when the key looks secret), marked
 *     new or changed, with Approve per server and Not now;
 *   - Settings → Advanced → "Approved vault MCP servers" with Revoke.
 *
 * Approve / revoke write the store in the user profile (never the vault)
 * and bump `plugin.mcpApprovalsGeneration`, which is part of the chat's
 * spawn signature — the next message respawns with --resume under the new
 * server set. The approval is for the hash that was SHOWN: if the file
 * changes between review and click, the new spec simply isn't approved.
 */

const path = require("path") as typeof import("path");
const { mcpApprovals } = require("@gryphon/protect");

interface PendingApproval { name: string; spec: any; specHash: string; reason: "new" | "changed" }
interface PendingReport { cwd?: string; vaultKey: string; pending: PendingApproval[] }

/**
 * Env keys that change WHAT runs rather than configure it (preloaded code,
 * search paths, startup files, package registries, proxies). Flagged with a
 * warning, and shown in full even when the key also looks secret: masking
 * `NODE_OPTIONS=--require ./evil.js` would hide the attack.
 */
const EXEC_ENV_RE = /^(PATH|PATHEXT|COMSPEC|SHELL|HOME|ZDOTDIR|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|PYTHON\w+|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH|NPM_CONFIG_\w+|YARN_\w+|PNPM_\w+|PIP_\w+|UV_\w+|PIPX_\w+|BUN_\w+|DENO_\w+|GIT_\w+|GO\w*FLAGS|GOPROXY|CARGO_\w+|RUSTC\w*|(?:HTTPS?|ALL|NO)_PROXY|LD_\w+|DYLD_\w+|\w+_PATH|\w+_HOME)$/i;
/**
 * Keys whose value is masked. Everything else is shown: the reviewer is
 * deciding whether to run this, and a hidden value can hide a redirection.
 */
const SECRET_KEY_RE = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTHORIZATION|COOKIE|CREDENTIAL/i;
/** A bare `${VAR}` / `${VAR:-default}` reference holds no secret itself. */
const VAR_REF_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/;
const SCRIPT_EXT_RE = /\.(?:js|mjs|cjs|ts|py|rb|pl|sh|bash|zsh|ps1|bat|cmd|jar|php|lua)$/i;
/**
 * Programs that load code or config from the working directory — python's
 * `-m` / sys.path[0], ruby, perl, php — the package runners and JS
 * runtimes that read `.npmrc` / `bunfig.toml` / `deno.json` / `uv.toml` /
 * `package.json` from it (`registry=` or `script-shell=` in a vault
 * `.npmrc` turns an innocent-looking `npx srv` into the vault's code),
 * build tools, and the shells / wrappers that could run any of them.
 * Matched after a version suffix is stripped (`ruby3.2`, `python3.13t`,
 * `pypy3`, `lua5.4`). It only picks the warning's WORDING: a vault-cwd
 * server is warned either way, so a missing entry costs strength, not the
 * warning (issue #28).
 */
const CWD_LOADING_RE = /^(?:python|py|pypy|ruby|perl|php|lua|luajit|node|nodejs|npx|npm|bun|bunx|deno|tsx|ts-node|uv|uvx|pip|pipx|poetry|pipenv|conda|pnpm|pnpx|yarn|corepack|make|just|rake|go|cargo|dotnet|java|mvn|gradle|gradlew|cmake|ninja|docker|podman|sh|bash|zsh|dash|fish|env|cmd|powershell|pwsh|nice|nohup|time|xargs|sudo)$/;
const STRONG_CWD_WARNING = "This server runs (or may run) code stored in the vault. Approving covers the command line, not that code: if the vault's files change, the new code runs without asking again.";
const SOFT_CWD_WARNING = "This server starts with the vault as its working directory. Some programs read config or code from there (e.g. `git` runs the vault's (or an enclosing) `.git/config` hooks and `core.fsmonitor`). Approve only if you know this program doesn't.";

/** Vault-supplied text → safe to display (Cc / bidi chars escaped). */
const _clean: (v: unknown) => string = mcpApprovals.displaySafe;

function _maskedPairs(obj: Record<string, unknown>, flagged: string[] | null): string {
  return Object.keys(obj).map((k) => {
    const v = String(obj[k]);
    if (flagged && EXEC_ENV_RE.test(k)) { flagged.push(k); return `⚠ ${k}=${v}`; }
    return SECRET_KEY_RE.test(k) && !VAR_REF_RE.test(v) ? `${k}=••••` : `${k}=${v}`;
  }).join(", ");
}

function _isAbsolute(p: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(p);
}

/** Does this command / arg point at a file the vault supplies? */
function _pointsIntoVault(token: unknown, vaultDir: string | null): boolean {
  if (typeof token !== "string" || !token || token.startsWith("-") || token.startsWith("@") || /^[a-z]+:\/\//i.test(token)) return false;
  const norm = token.replace(/\\/g, "/");
  const isAbs = norm.startsWith("/") || /^[A-Za-z]:\//.test(norm);
  if (isAbs) {
    if (!vaultDir) return false;
    // Collapse `..` so `/elsewhere/../vault/x` can't dodge the prefix check.
    const p = path.posix.normalize(norm).toLowerCase();
    const v = path.posix.normalize(vaultDir.replace(/\\/g, "/")).replace(/\/+$/, "").toLowerCase();
    return p === v || p.startsWith(v + "/");
  }
  // Relative: resolved against the server cwd, which defaults to the vault.
  return norm.startsWith("./") || norm.startsWith("../") || (norm.includes("/") && SCRIPT_EXT_RE.test(norm)) || SCRIPT_EXT_RE.test(norm);
}

/**
 * Human-readable view of a server spec for the approval modal. Env / header
 * values are shown unless the key looks secret (and isn't a `${VAR}`
 * reference); a value that changes what runs is always shown and flagged.
 * Adds a Warning row when the command runs code from inside the vault —
 * editing that code later does NOT invalidate the approval, which covers
 * the spec, not the files it points at. Every value is `_clean`ed.
 */
function describeServer(spec: any, vaultDir: string | null = null): Array<[string, string]> {
  const s = spec && typeof spec === "object" ? spec : {};
  const rows: Array<[string, string]> = [];
  const warnings: string[] = [];
  const type = typeof s.type === "string" ? s.type : (typeof s.url === "string" ? "http" : "stdio");
  rows.push(["Type", type]);
  if (typeof s.command === "string") {
    const args = Array.isArray(s.args) ? s.args : [];
    rows.push(["Command", [s.command, ...args].map((a: unknown) => JSON.stringify(String(a))).join(" ")]);
    // The cwd is the vault unless the spec sets one outside it, and any
    // program may read config or code from its cwd — so a vault cwd is
    // always warned. The strong text goes to interpreters, package runners,
    // build tools and wrappers (CWD_LOADING_RE), to bare or relative names
    // (PATH can resolve them to anything), to `-m`, and to anything pointing
    // into the vault; an unlisted absolute binary outside it gets the softer
    // text. Matched on the program, not its flags, since flags cluster
    // (`-Im`, `-mpkg`) in too many forms.
    const cwdInVault = typeof s.cwd !== "string" || !_isAbsolute(s.cwd) || _pointsIntoVault(s.cwd, vaultDir);
    const interp = String(s.command).replace(/\\/g, "/").split("/").pop()!.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, "").replace(/[\d.]+t?$/, "");
    const plainBinaryOutside = _isAbsolute(String(s.command)) && !_pointsIntoVault(s.command, vaultDir) && !CWD_LOADING_RE.test(interp);
    if ([s.command, ...args].some((t) => _pointsIntoVault(t, vaultDir)) || (cwdInVault && (!plainBinaryOutside || args.includes("-m")))) {
      warnings.push(STRONG_CWD_WARNING);
    } else if (cwdInVault) {
      warnings.push(SOFT_CWD_WARNING);
    }
  }
  if (typeof s.url === "string") rows.push(["URL", s.url]);
  if (typeof s.cwd === "string") rows.push(["Working directory", s.cwd]);
  const env = s.env && typeof s.env === "object" && !Array.isArray(s.env) ? s.env : null;
  if (env && Object.keys(env).length > 0) {
    const flagged: string[] = [];
    rows.push(["Environment", _maskedPairs(env, flagged)]);
    if (flagged.length > 0) warnings.push(`${flagged.join(", ")} changes what runs (shown in full above). Check ${flagged.length > 1 ? "them" : "it"} carefully.`);
  }
  const headers = s.headers && typeof s.headers === "object" && !Array.isArray(s.headers) ? s.headers : null;
  if (headers && Object.keys(headers).length > 0) {
    rows.push(["Headers", _maskedPairs(headers, null)]);
  }
  // Claude Code RUNS headersHelper to produce request headers: it's a
  // command line, so it gets its own row and a warning like one.
  if (s.headersHelper !== undefined) {
    rows.push(["Headers helper (runs a program)", typeof s.headersHelper === "string" ? s.headersHelper : JSON.stringify(s.headersHelper)]);
    warnings.push("This server runs a headersHelper program on your computer to produce its request headers. Check that command as carefully as a server command.");
  }
  // Unknown fields go under ONE fixed label: rendering each under its own
  // key would let a vault name a field "Warning" or "Command" and spoof a row.
  const known = new Set(["type", "command", "args", "url", "cwd", "env", "headers", "headersHelper"]);
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(s)) if (!known.has(k)) rest[k] = s[k];
  if (Object.keys(rest).length > 0) rows.push(["Other fields", JSON.stringify(rest)]);
  for (const w of warnings) rows.push(["Warning", w]);
  return rows.map(([k, v]) => [k, _clean(v)] as [string, string]);
}

/**
 * The entries not yet announced this session, recording them as announced.
 * Keyed on the spec hash, so an edited server is announced again.
 */
function takeUnannounced(seen: Set<string>, vaultKey: string, pending: PendingApproval[]): PendingApproval[] {
  const fresh = pending.filter((p) => !seen.has(`${vaultKey}\u0000${p.name}\u0000${p.specHash}`));
  for (const p of fresh) seen.add(`${vaultKey}\u0000${p.name}\u0000${p.specHash}`);
  return fresh;
}

function _bumpGeneration(plugin: any) {
  plugin.mcpApprovalsGeneration = (plugin.mcpApprovalsGeneration || 0) + 1;
}

/** Host hook for the provider: Notice with a Review action. */
function handlePendingApprovals(plugin: any, report: PendingReport) {
  if (!report || !Array.isArray(report.pending) || report.pending.length === 0) return;
  if (!plugin._mcpApprovalNoticesSeen) plugin._mcpApprovalNoticesSeen = new Set();
  const fresh = takeUnannounced(plugin._mcpApprovalNoticesSeen, report.vaultKey, report.pending);
  if (fresh.length === 0) return;
  const { Notice } = require("obsidian");
  const many = report.pending.length > 1;
  const names = report.pending.map((p) => (p.reason === "changed" ? `${_clean(p.name)} (changed)` : _clean(p.name))).join(", ");
  const notice = new Notice(
    `This vault defines MCP server${many ? "s" : ""} ${names} that ${many ? "haven't" : "hasn't"} been approved. ` +
    `${many ? "They" : "It"} won't run.`,
    20000,
  );
  const el = notice && notice.noticeEl;
  if (el && typeof el.createEl === "function") {
    const btn = el.createEl("button", { text: "Review" });
    btn.addEventListener("click", (ev: Event) => {
      ev.stopPropagation();
      notice.hide();
      openReviewModal(plugin, report);
    });
  }
}

function openReviewModal(plugin: any, report: PendingReport) {
  const { Modal, Setting, Notice } = require("obsidian");
  const modal = new Modal(plugin.app);
  modal.titleEl.setText("Review vault MCP servers");
  const c = modal.contentEl;
  c.createEl("p", {
    text:
      "This vault's .mcp.json asks to start the programs below. An MCP server runs on your computer " +
      "with your permissions, and a vault can come from anywhere. Approve only servers you recognise. " +
      "If a server's settings change later, you'll be asked again.",
  });
  for (const p of report.pending) {
    const box = c.createDiv({ cls: "gryphon-mcp-approval" });
    box.setCssStyles({ border: "1px solid var(--background-modifier-border)", borderRadius: "6px", padding: "8px 12px", margin: "8px 0" });
    const name = _clean(p.name);
    const head = box.createEl("h4", {
      text: p.reason === "changed" ? `${name} — changed since you approved it` : `${name} — new`,
    });
    head.setCssStyles({ margin: "0 0 6px 0" });
    for (const [label, value] of describeServer(p.spec, report.cwd || report.vaultKey)) {
      const row = box.createDiv();
      row.createEl("strong", { text: `${label}: ` });
      const code = row.createEl("code", { text: value });
      code.setCssStyles({ wordBreak: "break-all" });
    }
    if (!mcpApprovals.isApprovableName(p.name)) {
      box.createEl("p", { text: `A server named "${name}" can't be approved. Rename it in the vault's .mcp.json to run it.` });
      continue;
    }
    new Setting(box).addButton((btn: any) =>
      btn.setButtonText("Approve").setCta().onClick(() => {
        try {
          mcpApprovals.approve(report.vaultKey, p.name, p.specHash);
          _bumpGeneration(plugin);
          btn.setButtonText("Approved").setDisabled(true);
          new Notice(`Approved ${name}. It starts with your next message.`);
        } catch (e) {
          new Notice(`Couldn't save the approval: ${(e && (e as Error).message) || e}`);
        }
      })
    );
  }
  new Setting(c).addButton((btn: any) => btn.setButtonText("Not now").onClick(() => modal.close()));
  modal.open();
}

/** Settings → Advanced: this vault's approvals, each with Revoke. */
function renderApprovedServersSetting(plugin: any, panelEl: any, descToTooltip: (s: any, t: string) => any) {
  const { Setting, Notice } = require("obsidian");
  const basePath = plugin.app && plugin.app.vault && plugin.app.vault.adapter && plugin.app.vault.adapter.basePath;
  descToTooltip(
    new Setting(panelEl).setName("Approved vault MCP servers").setHeading(),
    "Claude Code mode only. MCP servers defined in this vault's .mcp.json run only after you " +
    "approve them. Approvals are stored outside the vault, so a shared or cloned vault can't " +
    "approve its own servers. Revoking takes effect on your next message.",
  );
  if (!basePath) return;
  const vk = mcpApprovals.vaultKey(basePath);
  const entries = mcpApprovals.listForVault(mcpApprovals.load(), vk);
  if (entries.length === 0) {
    new Setting(panelEl).setDesc("No servers approved for this vault.");
    return;
  }
  for (const e of entries) {
    const when = e.approvedAt ? e.approvedAt.slice(0, 10) : "unknown date";
    const row = new Setting(panelEl).setName(_clean(e.name)).setDesc(`Approved ${when}`);
    row.addButton((btn: any) =>
      btn.setButtonText("Revoke").setWarning().onClick(() => {
        try {
          mcpApprovals.revoke(vk, e.name);
          _bumpGeneration(plugin);
          row.settingEl.remove();
          new Notice(`Revoked ${_clean(e.name)}. It won't start from your next message.`);
        } catch (err) {
          new Notice(`Couldn't revoke: ${(err && (err as Error).message) || err}`);
        }
      })
    );
  }
}

module.exports = {
  describeServer,
  takeUnannounced,
  handlePendingApprovals,
  openReviewModal,
  renderApprovedServersSetting,
};

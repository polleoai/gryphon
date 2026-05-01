/**
 * Permission gating for write-side tools.
 *
 * The active permission mode (read from ctx.permissionMode) decides
 * whether a write/edit/bash invocation proceeds, prompts the user, or
 * is refused outright.
 *
 * Modes (mirror Claude Code's):
 *   "default"            → prompt the user (modal); cache decision
 *                          per-file for the session if "remember" ticked
 *   "acceptEdits"        → auto-accept silently
 *   "bypassPermissions"  → auto-accept silently (YOLO)
 *   "plan"               → refuse; tell the model to propose only
 *
 * Returning a refusal as a tool error (not a thrown exception) is
 * intentional — it tells the model what happened and lets it adapt.
 */

const { Modal, Setting } = require("obsidian");

// Per-session cache: filePath → "always" | "deny-always".
// Lives on the plugin instance so it survives across tool calls within
// a chat turn but resets when the plugin reloads.
function _ensureSessionCache(plugin) {
  if (!plugin) return null;
  if (!plugin._permSessionCache) plugin._permSessionCache = new Map();
  return plugin._permSessionCache;
}

/**
 * @param {object} args
 *   ctx       — { permissionMode, plugin, vaultRoot, ... }
 *   action    — short verb: "write", "edit", "delete", "run"
 *   target    — file path (or command preview) the action affects
 *   detail    — optional preview body shown in the modal (diff, content)
 *
 * @returns {Promise<{allow: boolean, reason: string}>}
 */
async function checkPermission({
  ctx,
  action,
  target,
  detail,
  cacheable = true,
  kind = "fileEdit",
  warning = null,
  category = null,
  categoryTitle = null,
}) {
  const mode = ctx.permissionMode || "default";
  const settings = (ctx.plugin && ctx.plugin.settings) || {};
  const protectedModeOn = settings.protectedMode !== false;            // default true
  const autoDenyProtected = settings.autoDenyProtected === true;

  if (mode === "plan") {
    return {
      allow: false,
      reason:
        `Plan mode is active — ${action} on ${target} is not permitted. ` +
        `Describe what you would do instead, or ask the user to switch to ` +
        `Safe / YOLO mode if they want you to proceed.`,
    };
  }

  // Protected Mode controls whether kind:protected / kind:protected-exec
  // gets special treatment at all. When Protected Mode is off, protected kinds
  // are demoted to their non-protected counterparts so all downstream
  // logic (Safe / YOLO fast-paths, modal styling, caching) treats them
  // as ordinary ops. This is the "real YOLO" path the user opted into.
  const wasProtected = kind === "protected" || kind === "protected-exec";
  if (wasProtected && !protectedModeOn) {
    kind = kind === "protected-exec" ? "exec" : "fileEdit";
    warning = null;
    category = null;
    categoryTitle = null;
  }

  // Protected kinds ("protected" for file writes, "protected-exec" for
  // shell commands) override Safe / YOLO auto-accept. The user opted
  // into automation for routine operations, not for edits to Gryphon's
  // own settings or `rm -rf`. These go straight to the modal, never
  // cached. Plan mode still refuses them above.
  const isProtected = kind === "protected" || kind === "protected-exec";

  // Protected Mode ON + auto-deny: refuse protected ops without any modal.
  // Matches the CLI-mode deny-only settings file behaviour so the two
  // providers are symmetric from the user's perspective. Reason text is
  // prescriptive so the model relays something useful to the user
  // instead of improvising "the path might not exist" speculation.
  if (isProtected && autoDenyProtected) {
    const settingsPath = kind === "protected-exec"
      ? "Protected commands"
      : "Protected file paths";
    const reason =
      `This operation matches one of your protected patterns in Gryphon.` +
      `\n\nTo allow it:\n` +
      `- Open Obsidian → Settings → Gryphon → ${settingsPath}\n` +
      `- Uncheck the matching pattern\n` +
      `- Ask me again`;
    // Direct chat-view render retired in v0.9.2 — the per-turn
    // reminder injection reliably produces a verbatim model echo,
    // making the dual render redundant. See plugin.js notes for
    // the re-enable path if drift returns.
    return { allow: false, reason };
  }
  if (isProtected) {
    // Skip bypassPermissions / acceptEdits fast-paths — fall through to
    // the modal below.
  } else if (mode === "bypassPermissions") {
    return { allow: true, reason: "" };
  } else if (mode === "acceptEdits" && kind === "fileEdit") {
    // acceptEdits auto-accepts file edits (Write, Edit) but NOT exec
    // (Bash). The mode's promise is "trust Claude with my files" —
    // shell commands are a different trust level and must always
    // prompt unless user explicitly opts into YOLO.
    return { allow: true, reason: "" };
  }

  // mode === "default" OR protected kind → prompt user.
  // The session cache is opt-in per call: file edits cache by target so
  // the user isn't re-prompted on the same file, but bash commands MUST
  // NOT cache (each command is its own decision; caching `rm -rf` once
  // would auto-allow it forever). Protected kinds also skip the cache —
  // every attempt to modify Gryphon config / run a dangerous command
  // should surface the warning every time.
  const effectiveCacheable = cacheable && !isProtected;
  const cache = effectiveCacheable ? _ensureSessionCache(ctx.plugin) : null;
  if (cache && cache.has(target)) {
    const cached = cache.get(target);
    if (cached === "always") return { allow: true, reason: "" };
    if (cached === "deny-always") {
      return {
        allow: false,
        reason: `User previously denied ${action} on ${target} for this session.`,
      };
    }
  }

  if (!ctx.plugin || !ctx.plugin.app) {
    // No way to surface a modal — fall back to refuse so we don't write
    // silently when we can't ask. Safer default.
    return {
      allow: false,
      reason: `Cannot prompt user (plugin context unavailable). Set permission mode to Safe or YOLO to allow ${action} operations.`,
    };
  }

  const decision = await _showPermissionModal({
    app: ctx.plugin.app,
    action,
    target,
    detail,
    showRememberToggle: effectiveCacheable,
    warning,
    isProtected,
    category,
    categoryTitle,
  });

  if (decision.remember && cache) {
    cache.set(target, decision.allow ? "always" : "deny-always");
  }

  // When the user denies a PROTECTED operation via the modal, return
  // the same prescriptive reason the CLI hook path emits. Without this,
  // Anthropic API mode returns a generic "User denied run shell command on …"
  // which the model paraphrases however it feels ("please adjust your
  // protected pattern list"), producing a visibly shorter / vaguer
  // response than Claude Code mode for the same denial. Matching the reasons
  // keeps the two providers' output identical for the same user action.
  //
  // Non-protected denials keep the generic reason — there's no pattern
  // to point at, so the prescriptive recipe wouldn't apply.
  let refusalReason;
  if (isProtected) {
    const categoryLabel = category
      ? ` (${category.replace(/-/g, " ")})`
      : "";
    const settingsPath = kind === "protected-exec"
      ? "Protected commands"
      : "Protected file paths";
    refusalReason =
      `This operation matches one of your protected patterns in Gryphon` +
      `${categoryLabel}.\n\nTo allow it:\n` +
      `- Open Obsidian → Settings → Gryphon → ${settingsPath}\n` +
      `- Uncheck the matching pattern\n` +
      `- Ask me again`;
  } else {
    refusalReason = `User denied ${action} on ${target}.`;
  }

  // Direct chat-view render retired in v0.9.2 — see autoDenyProtected
  // branch for rationale.

  return {
    allow: decision.allow,
    reason: decision.allow ? "" : refusalReason,
  };
}

// Upper bounds on the strings rendered into the modal DOM. A prompt-injected
// multi-MB `target` or `detail` would freeze Obsidian's renderer at modal
// open. `target` stays comfortably larger than any legitimate command or
// path (8 KB ~ a very long command line or full path); `detail` is bigger
// because it can hold full diffs or preview content. Anything longer is
// truncated with a visible marker so the user sees that content was
// elided — they can still inspect the raw tool-use block in the chat log.
const MAX_MODAL_TARGET_CHARS = 8 * 1024;
const MAX_MODAL_DETAIL_CHARS = 100 * 1024;

function _clip(text, max) {
  if (typeof text !== "string" || text.length <= max) return text;
  const elided = text.length - max;
  return text.slice(0, max) + `\n\n[truncated — ${elided} additional chars hidden; see full tool-use block in the chat log]`;
}

function _showPermissionModal({
  app,
  action,
  target,
  detail,
  showRememberToggle = true,
  warning = null,
  isProtected = false,
  category = null,
  categoryTitle = null,
}) {
  return new Promise((resolve) => {
    const modal = new Modal(app);

    // Title — for protected operations, prefer the category-specific
    // title ("⚠ Modifies Gryphon configuration" etc.) so the user sees
    // the threat category at a glance. Ordinary (non-protected) calls
    // use the generic confirm title.
    modal.titleEl.setText(
      isProtected
        ? (categoryTitle || `⚠ Gryphon: confirm protected ${action}`)
        : `Gryphon: confirm ${action}`
    );

    const safeTarget = _clip(target, MAX_MODAL_TARGET_CHARS);
    const safeDetail = detail ? _clip(detail, MAX_MODAL_DETAIL_CHARS) : detail;

    if (isProtected) {
      // Plain-language body — the `warning` string is the descriptive
      // `userRisk` copy from constants.js (what the asset is / why it's
      // risky). Title already shows the category, so the banner body
      // just carries the description.
      const banner = modal.contentEl.createEl("div", {
        cls: "gryphon-permission-warning",
      });
      banner.createEl("p", {
        cls: "gryphon-permission-warning-body",
        text: warning ||
          `Gryphon flagged this operation because it matches a protected pattern.`,
      });

      modal.contentEl.createEl("p", {
        cls: "gryphon-permission-summary",
        text: `Claude is asking to ${action} ${safeTarget}.`,
      });

      // Explicit consequence line — tells the user exactly what each
      // button does, so "Approve" doesn't live in an ambiguous context.
      modal.contentEl.createEl("p", {
        cls: "gryphon-permission-consequence",
        text:
          `If you click Approve, Claude will go ahead with this operation. ` +
          `If you click Deny, Gryphon blocks it and tells Claude it was refused. ` +
          `When in doubt, Deny.`,
      });
    } else {
      // Unprotected ordinary confirmation — inline form, no banner.
      modal.contentEl.createEl("p", {
        text: `Claude wants to ${action} ${safeTarget}. Allow?`,
        cls: "gryphon-permission-summary",
      });
    }

    // Detail preview. Unprotected (routine) calls show the preview
    // inline — that's the whole point of the prompt (see the diff,
    // see the full command before approving). Protected calls suppress
    // the detail block entirely: the title (category), warning body
    // (plain-language risk), summary (command target), and consequence
    // line already communicate everything the user needs to decide,
    // and dumping the raw tool payload added clutter without adding
    // signal. Users who want the raw text can open the dev-tools
    // console; this is the on-screen decision surface.
    if (safeDetail && !isProtected) {
      const pre = modal.contentEl.createEl("pre", {
        cls: "gryphon-permission-detail",
      });
      pre.style.maxHeight = "300px";
      pre.style.overflow = "auto";
      pre.style.fontSize = "12px";
      pre.style.padding = "8px";
      pre.style.background = "var(--background-secondary)";
      pre.style.borderRadius = "4px";
      pre.setText(safeDetail);
    }

    let remember = false;
    if (showRememberToggle) {
      new Setting(modal.contentEl)
        .setName("Remember for this session")
        .setDesc("Skip this prompt for the same target until the plugin reloads.")
        .addToggle((t) => t.setValue(false).onChange((v) => { remember = v; }));
    }

    let resolved = false;
    const finish = (allow) => {
      if (resolved) return;
      resolved = true;
      modal.close();
      resolve({ allow, remember });
    };

    // For protected operations, Deny is the CTA-styled default button
    // (eye-catching blue, caught by Enter key if the modal handler
    // forwards Enter to the default action). Approve is plain-styled,
    // avoiding accidental click-through. For unprotected operations,
    // Allow remains the CTA to match existing UX.
    const buttons = new Setting(modal.contentEl);
    if (isProtected) {
      buttons
        .addButton((btn) =>
          btn.setButtonText("Approve").onClick(() => finish(true))
        )
        .addButton((btn) =>
          btn.setButtonText("Deny").setCta().onClick(() => finish(false))
        );
    } else {
      buttons
        .addButton((btn) =>
          btn.setButtonText("Deny").onClick(() => finish(false))
        )
        .addButton((btn) =>
          btn.setButtonText("Allow").setCta().onClick(() => finish(true))
        );
    }

    // Keyboard shortcuts:
    //   - Enter alone → the CTA button (Deny for protected; Allow for
    //     unprotected). Inherits the modal's default-button semantics.
    //   - Esc → deny (via modal.onClose below).
    //   - Cmd/Ctrl + Enter → always approve (intentional combo so a
    //     user can approve quickly without the CTA-is-Deny trap).
    const scopeEl = modal.contentEl;
    const keyHandler = (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish(isProtected ? false : true);
      }
      // Esc is already handled by Obsidian's modal-close path.
    };
    scopeEl.addEventListener("keydown", keyHandler);

    // Treat closing the modal (X / Esc) as a denial — never as silent allow.
    modal.onClose = () => finish(false);

    modal.open();
  });
}

module.exports = { checkPermission };

/**
 * Single source of truth for the canonical Gryphon protected-deny
 * copy that gets shown to users.
 *
 * Why this exists
 * ---------------
 * The deny text is emitted from at least three runtime sites:
 *   1. `plugin._handleClassifyRequest` — when the BeforeTool /
 *      PreToolUse hook gates a CLI tool call.
 *   2. `permission-gate.checkPermission` (auto-deny path) — when
 *      Protected Mode + Auto-deny is on for an SDK tool.
 *   3. `permission-gate.checkPermission` (modal-deny path) — when
 *      the user clicks Deny in the protected-pattern modal.
 *
 * Plus it appears in three system-prompt examples (claude-code's
 * `--append-system-prompt`, codex-cli's `model_instructions_file`,
 * gemini-cli's settings JSON) so the model knows what to quote
 * verbatim.
 *
 * If those copies drift, models receive ambiguous "what should I
 * say?" signals and produce paraphrased / inconsistent output. One
 * shared builder = one canonical text = uniform output across all
 * six provider modes.
 *
 * The current copy (2026-05-04) is the conversational descriptive
 * form: it names the operation, the target, and the matched
 * category in plain language, then lists the action steps. Earlier
 * "This operation matches..." form was generic and gave the user
 * no signal about WHAT was blocked.
 *
 *   "The Gryphon plugin is blocking the deletion of `/tmp/x.md`
 *    because it matches one of your protected patterns
 *    (destructive operation).
 *
 *    To allow it:
 *    - Open Obsidian → Settings → Gryphon → Protected commands
 *    - Uncheck the matching pattern
 *    - Ask me again"
 */

/**
 * Render a human-friendly description of the operation Gryphon
 * blocked. Uses the structured `action` + `target` Gryphon already
 * derives at classify time, plus a small special-case for shell
 * commands that start with a destructive verb so we can say
 * "deletion of <path>" instead of "execution of `rm <path>`".
 */
function describeOperation(action, target) {
  const t = typeof target === "string" ? target : "";
  if (action === "write") return `write to \`${t}\``;
  if (action === "edit") return `edit of \`${t}\``;
  if (action === "run") {
    // Detect a destructive verb at the start of a shell command.
    // The capture group grabs the FIRST argument to the verb (the
    // path being acted on); we surface that rather than the full
    // command for cleaner phrasing. Falls back to "execution of
    // <full command>" when the command isn't one of the
    // recognised verbs.
    const m = t.match(/^\s*(?:sudo\s+)?(rm|del|erase|unlink|shred|rmdir|rd)\b[^\S\r\n]+(?:-[A-Za-z]+\s+)*([^\s]+)/i);
    if (m) return `deletion of \`${m[2]}\``;
    return `execution of \`${t}\``;
  }
  // Fallback for any tool name we haven't special-cased.
  return `${action} of \`${t}\``;
}

/**
 * The canonical opening sentence — used by chat-view as a marker
 * for the deny block (anchors paragraph separation, dedupe gating,
 * and the post-deny clarifier flag).
 *
 * Stable byte-for-byte. Never localized at this layer (Gryphon
 * itself is English-only); never reworded mid-version.
 */
const CANONICAL_OPENING = "The Gryphon plugin is blocking the ";

/**
 * Settings sub-page name based on the kind of operation. The exec
 * verbs (Bash / PowerShell / shell) live under "Protected
 * commands"; file mutators (Write / Edit) live under "Protected
 * file paths".
 */
function settingsPathForKind(kind) {
  return kind === "protected-exec" ? "Protected commands" : "Protected file paths";
}

/**
 * Build the full deny copy.
 *
 * @param {object} args
 *   action — "write" | "edit" | "run" | tool-name (lowercased)
 *   target — file path or command preview
 *   category — null | classification.category (e.g. "destructive-operation")
 *   kind — "protected" | "protected-exec" (decides settings path)
 * @returns {string}
 */
function buildDenyReason({ action, target, category, kind }) {
  const description = describeOperation(action, target);
  const categoryLabel = category
    ? ` (${String(category).replace(/-/g, " ")})`
    : "";
  const settingsPath = settingsPathForKind(kind);
  return (
    `${CANONICAL_OPENING}${description} because it matches one of ` +
    `your protected patterns${categoryLabel}.\n\n` +
    `To allow it:\n` +
    `- Open Obsidian → Settings → Gryphon → ${settingsPath}\n` +
    `- Uncheck the matching pattern\n` +
    `- Ask me again`
  );
}

module.exports = {
  CANONICAL_OPENING,
  describeOperation,
  settingsPathForKind,
  buildDenyReason,
};

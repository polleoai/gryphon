/**
 * Bundled skill content shipped with Gryphon. On first plugin load (or any
 * load where a bundled file is missing), the skill loader writes each of
 * these into the vault under Gryphon/Skills/. Existing files are never
 * overwritten — user customizations are preserved across upgrades.
 *
 * Editing a bundled skill in the vault takes effect on next invocation
 * (hot reload via vault events). Deleting a bundled skill removes it
 * from autocomplete; it will be recreated on the next plugin reload
 * (we don't track a seen-list in v1).
 */

const README = `# Gryphon Skills

Skills are user-authored slash commands that expand a prompt template and
send it as a chat message. Type \`/<skill-name>\` in the Gryphon chat and
Gryphon expands the skill's body (substituting any arguments you typed)
and sends the result to Claude.

## File format

Each skill is a single \`.md\` file in this folder:

\`\`\`markdown
---
name: my-skill
description: One-line summary shown in the autocomplete dropdown
argument-hint: "[optional args]"
---
The body of your skill goes here. This is a prompt template — whatever
you write becomes a user message to Claude when the skill fires.

Use {{args}} anywhere to substitute whatever the user typed after the
command name. If no args were given, {{args}} becomes empty string.
\`\`\`

**Fields:**

- \`name\` (required) — becomes the slash command (\`name: tag-suggest\` →
  \`/tag-suggest\`). Lowercase + hyphens. Must not collide with a Gryphon
  built-in (\`clear\`, \`compact\`, \`context\`, \`cost\`, \`effort\`, \`export\`,
  \`model\`, \`perm\`, \`quote\`, \`settings\`, \`stop\`, \`usage\`).
- \`description\` (required) — shown in the autocomplete dropdown. Keep
  under 60 characters.
- \`argument-hint\` (optional) — displayed after the command name in the
  dropdown, e.g. \`[optional focus]\`. Purely informational.

**Body:** plain Markdown. \`{{args}}\` is the only template feature.

## Creating a new skill

Three ways:

1. **Ask Claude in Gryphon chat**: *"Read Gryphon/Skills/README.md, then
   create a skill at Gryphon/Skills/weekly-review.md that summarizes the
   last week of my journal entries."* Claude writes the file; Gryphon
   picks it up on next autocomplete.
2. **Copy + edit**: duplicate any bundled skill, rename, edit the
   frontmatter and body, save.
3. **From scratch**: create an \`.md\` file with the frontmatter block
   above and your template body.

The folder is live — Gryphon watches for changes and updates the command
list without reload.

## What skills CAN do

Anything a normal chat turn can do. The skill body is sent as a user
message, so Claude has the full toolbox (Read, Write, Edit, Glob, Grep,
WebFetch, WebSearch, Bash, plus any MCP tools) plus the auto-injected
active-file context.

## What skills CAN'T do (v1)

- Override the current model, effort, or permission mode
- Run without creating a visible chat turn
- Restrict Claude's tool access (skills inherit session-wide access)
- Use template features beyond \`{{args}}\`

These are in \`docs/gryphon-skills-design.md\` §13 if you want the rationale.

## Bundled skills

Gryphon ships five starter skills that live next to this README. You can
edit them freely — customizations persist across upgrades. If you delete
one, it'll be recreated on the next plugin reload. To permanently replace
a bundled skill, keep the file but change its contents.
`;

const TAG_SUGGEST = `---
name: tag-suggest
description: Propose Obsidian tags for the active note
argument-hint: "[style: casual|academic|...]"
---
Read the note currently open in Obsidian — the auto-injected
\`[gryphon-context]\` block at the start of the conversation gives you
the path.

Propose 3 to 5 tags appropriate for this note following Obsidian
conventions: lowercase, hyphen-separated, no spaces, no leading \`#\`
(the user adds that themselves). Prefer general-enough tags that
they'll apply to other notes too — a tag that fits only this one note
is not useful.

For each tag, give a one-line rationale explaining why it fits.

Return a bulleted list. Do NOT edit the note — just propose.

Style preference (if provided): {{args}}
`;

const BACKLINKS = `---
name: backlinks
description: List notes that link to the active note with context
---
Read the note currently open — its path is in the auto-context. The
note's "name" for wikilink purposes is the filename without \`.md\`.

Use Glob on \`**/*.md\` to find candidate files, then Grep for
\`[[<note-name>]]\` (and also \`[[<note-name>|\` for aliased links) across
the vault. Skip the note itself.

For each match, report:
- the source note path (as a wikilink)
- a context snippet of about 50 words around the link

If no backlinks exist, say so clearly — that often means the note is an
orphan and might benefit from being linked somewhere.

{{args}}
`;

const FORWARD_LINKS = `---
name: forward-links
description: List outgoing wikilinks from the active note and flag broken ones
---
Read the note currently open. Extract every \`[[wikilink]]\` (including
aliased forms like \`[[target|alias]]\` and header links like
\`[[target#heading]]\`).

For each link target, use Glob to check whether a file named
\`<target>.md\` (or \`<target>/index.md\`) exists anywhere in the vault.

Return a Markdown table:

| Link | Target exists? | Path (if found) |
|---|---|---|

Flag broken links (no target found) prominently above the table — those
are the ones the user most likely wants to fix.

{{args}}
`;

const SUMMARIZE = `---
name: summarize
description: Summarize the active note (or an argument-provided target)
argument-hint: "[path/to/note.md or folder]"
---
Produce a summary of the target document.

Target resolution:
- If \`{{args}}\` is non-empty, treat it as a path — Read that file (or, if
  it's a folder, summarize across all \`.md\` files in it using Glob).
- Otherwise, summarize the note currently open (path is in the
  auto-context).

Return:
1. A 2 to 3 sentence abstract.
2. 3 to 5 key points as a bulleted list, each one sentence.
3. Any notable open questions or unresolved claims the note contains.

Keep it compact. Do not edit the source.
`;

const LINT_NOTE = `---
name: lint-note
description: Check the active note for common usability issues
---
Read the note currently open. Check for these issues and report what you
find. Do NOT auto-fix — just list findings with file:line locations
where applicable.

1. **Broken wikilinks** — \`[[target]]\` where no matching file exists
   anywhere in the vault (use Glob to verify).
2. **Missing frontmatter** — if other notes in the same folder have
   YAML frontmatter and this one doesn't, flag it.
3. **Heading-level skips** — e.g. an H1 followed directly by an H3
   (skipping H2). Each skip is one finding.
4. **Unclosed code fences** — \`\`\` that opens but is never closed.
5. **TODO / FIXME markers** — anything matching \`TODO:\`, \`FIXME:\`, or
   \`XXX:\`. List each with its line and surrounding context.

Format the output as a Markdown checklist grouped by category. If
everything looks clean, say so explicitly — don't invent issues.

{{args}}
`;

module.exports = {
  "README.md": README,
  "tag-suggest.md": TAG_SUGGEST,
  "backlinks.md": BACKLINKS,
  "forward-links.md": FORWARD_LINKS,
  "summarize.md": SUMMARIZE,
  "lint-note.md": LINT_NOTE,
};

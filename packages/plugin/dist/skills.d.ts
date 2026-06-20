/**
 * Gryphon skill loader.
 *
 * Skills are user-authored `.md` files under `<vault>/Gryphon/Skills/` that
 * become slash commands (`/<skill-name>`) in the chat. The loader:
 *   - Ensures the folder exists and is seeded with bundled skills
 *   - Parses YAML frontmatter from each file (name, description, argument-hint)
 *   - Registers valid skills in a name-to-entry map
 *   - Watches vault events for hot reload on create/modify/delete/rename
 *   - Exposes `expand(name, args)` to substitute `{{args}}` into the body
 *
 * See docs/gryphon-skills-design.md for the full design and file format.
 */
export {};

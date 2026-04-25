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

const fs = require("fs");
const path = require("path");
const { TFile, Notice } = require("obsidian");
const { SLASH_COMMANDS, RESERVED_SKILL_NAMES } = require("./constants");
const BUNDLED_SKILLS = require("./bundled-skills");
const BUNDLED_DOCS = require("./bundled-docs");

const GRYPHON_DIR = "Gryphon";
const SKILLS_DIR = "Gryphon/Skills";
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
// Skill names become slash commands like "/<name>", so they must follow
// the same lexical rules: lowercase letters, digits, and hyphens; no
// spaces, no underscores, no leading hyphen. Mirrors Claude Code's skill
// name conventions for cross-tool consistency.
const SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/;

function parseFrontmatter(yaml) {
  const out = {};
  for (const raw of yaml.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function parseSkillFile(text) {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) throw new Error("missing or malformed frontmatter block");
  const fm = parseFrontmatter(m[1]);
  const body = m[2].replace(/^\n+/, "");
  return { frontmatter: fm, body };
}

class SkillRegistry {
  constructor(app) {
    this.app = app;
    this.skills = new Map();
    // Per-file load errors keyed by vault path. Surfaced via getErrors()
    // so the chat view can show the user which skills failed to load
    // and why, instead of silently dropping them on the floor.
    this.errors = new Map();
    this.eventRefs = [];
    // Tracks in-flight _loadFile promises so unload() can await them.
    // Without this, a modify-event fires _loadFile async and the load
    // completes AFTER unload() clears state — rewriting this.skills post-
    // unload and leaving a zombie registration.
    this._pendingLoads = new Set();
    this._unloaded = false;
  }

  /**
   * Returns currently-tracked skill load errors as an array of
   * { path, message } objects, ordered by path. Empty if all skill
   * files in Gryphon/Skills/ parsed successfully.
   */
  getErrors() {
    return [...this.errors.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, message]) => ({ path, message }));
  }

  async init() {
    await this._ensureSkillsFolder();
    await this._scanAll();
    this._attachWatchers();
  }

  async unload() {
    this._unloaded = true;
    for (const ref of this.eventRefs) this.app.vault.offref(ref);
    this.eventRefs = [];
    // Wait for any load that was kicked off before we set _unloaded so
    // it doesn't write into skills/errors AFTER we clear them below.
    // Each pending promise checks _unloaded after it awaits and bails.
    if (this._pendingLoads.size > 0) {
      await Promise.allSettled([...this._pendingLoads]);
    }
    this.skills.clear();
    this.errors.clear();
    this._pendingLoads.clear();
  }

  effectiveSlashCommands() {
    const skillEntries = Array.from(this.skills.values()).map((s) => ({
      cmd: `/${s.name}`,
      desc: s.description + (s.argumentHint ? ` ${s.argumentHint}` : ""),
      takesArgs: !!s.argumentHint,
      isSkill: true,
    }));
    return [...SLASH_COMMANDS, ...skillEntries]
      .sort((a, b) => a.cmd.localeCompare(b.cmd));
  }

  expand(name, args) {
    const skill = this.skills.get(name);
    if (!skill) return null;
    return skill.body.replaceAll("{{args}}", args || "");
  }

  has(name) { return this.skills.has(name); }

  async _ensureSkillsFolder() {
    const adapter = this.app.vault.adapter;
    await this._migrateLegacyHermesFolder(adapter);
    // Parent Gryphon/ folder + bundled vault docs (MANUAL.md, etc.)
    if (!(await adapter.exists(GRYPHON_DIR))) {
      await this.app.vault.createFolder(GRYPHON_DIR);
    }
    for (const [filename, content] of Object.entries(BUNDLED_DOCS)) {
      const p = `${GRYPHON_DIR}/${filename}`;
      if (!(await adapter.exists(p))) {
        await this.app.vault.create(p, content);
      }
    }
    // Gryphon/Skills/ folder + bundled skill files
    if (!(await adapter.exists(SKILLS_DIR))) {
      await this.app.vault.createFolder(SKILLS_DIR);
    }
    for (const [filename, content] of Object.entries(BUNDLED_SKILLS)) {
      const p = `${SKILLS_DIR}/${filename}`;
      if (!(await adapter.exists(p))) {
        await this.app.vault.create(p, content);
      }
    }
  }

  async _migrateLegacyHermesFolder(adapter) {
    // One-time migration for users who installed this plugin under its
    // previous name "Hermes" (renamed to Gryphon at v1.0.0). If the
    // legacy "Hermes" folder exists and "Gryphon" doesn't, rename in
    // place so the user keeps their skills, exports, and MANUAL.md.
    // If both exist, leave the legacy folder alone — merging is not
    // safe to do silently.
    try {
      const hasLegacy = await adapter.exists("Hermes");
      const hasNew = await adapter.exists(GRYPHON_DIR);
      if (hasLegacy && !hasNew) {
        await adapter.rename("Hermes", GRYPHON_DIR);
        new Notice(`Renamed vault folder 'Hermes' → '${GRYPHON_DIR}'.`);
      }
    } catch (err) {
      console.error("[gryphon] vault folder migration failed:", err);
    }
  }

  async _scanAll() {
    this.skills.clear();
    const folder = this.app.vault.getAbstractFileByPath(SKILLS_DIR);
    if (!folder || !folder.children) return;
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md" &&
          child.name !== "README.md") {
        await this._loadFile(child);
      }
    }
  }

  _loadFile(file) {
    // Wrap the real loader so unload() can await all in-flight loads.
    const p = this._doLoadFile(file).finally(() => {
      this._pendingLoads.delete(p);
    });
    this._pendingLoads.add(p);
    return p;
  }

  async _doLoadFile(file) {
    // Clear any prior error for this path so re-loads (modify event)
    // don't accumulate stale messages.
    this.errors.delete(file.path);

    // Symlink guard: if the skill file is a symlink whose realpath is
    // outside the vault, refuse to load it. The Obsidian desktop adapter
    // delegates vault.read() to Node's fs, which happily follows symlinks —
    // so a planted symlink in Gryphon/Skills/ could ship an external file's
    // contents as a slash-command body (prompt-injection vector). Also
    // reject broken symlinks. Skipped on mobile/unusual adapters where
    // basePath isn't exposed.
    const basePath = this.app.vault?.adapter?.basePath;
    if (typeof basePath === "string" && basePath.length > 0) {
      try {
        const absPath = path.join(basePath, file.path);
        const real = fs.realpathSync(absPath);
        const realBase = fs.realpathSync(basePath);
        const rel = path.relative(realBase, real);
        if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
          this._recordError(file.path,
            "Refusing to load skill: the file resolves outside the vault via a symlink. " +
            "Move the skill content into the vault directly.");
          return;
        }
      } catch (e) {
        this._recordError(file.path,
          `Cannot resolve skill path (broken symlink or permission error): ${e.message}`);
        return;
      }
    }

    let parsed;
    try {
      const text = await this.app.vault.read(file);
      parsed = parseSkillFile(text);
    } catch (e) {
      this._recordError(file.path,
        `Frontmatter parse failed: ${e.message}. ` +
        `Skill files must start with a YAML block (--- ... ---) ` +
        `containing at least 'name' and 'description'.`);
      return;
    }
    if (this._unloaded) return;  // aborted mid-load by a concurrent unload()
    const { frontmatter, body } = parsed;
    const name = frontmatter.name;
    const description = frontmatter.description;
    const argumentHint = frontmatter["argument-hint"] || "";

    if (!name) {
      this._recordError(file.path,
        "Missing required frontmatter field 'name'. Add `name: my-skill` " +
        "between the --- markers.");
      return;
    }
    if (!description) {
      this._recordError(file.path,
        `Missing required frontmatter field 'description' (skill '${name}'). ` +
        "Add `description: One-line summary` so users can see what the skill does in autocomplete.");
      return;
    }
    if (!SKILL_NAME_RE.test(name)) {
      this._recordError(file.path,
        `Invalid skill name '${name}'. Names must be lowercase, start with ` +
        "a letter, and contain only letters, digits, and hyphens (no spaces " +
        "or underscores). Example: 'tag-suggest'.");
      return;
    }
    if (RESERVED_SKILL_NAMES.has(name)) {
      this._recordError(file.path,
        `Name '${name}' is reserved by a built-in Gryphon command. ` +
        "Pick a different name to avoid the collision.");
      return;
    }
    if (this.skills.has(name)) {
      const existing = this.skills.get(name);
      this._recordError(file.path,
        `Name '${name}' is already registered by ${existing.path}. ` +
        "Two skills can't share the same name; rename one.");
      return;
    }
    this.skills.set(name, { name, description, argumentHint, body, path: file.path });
  }

  _recordError(filePath, message) {
    this.errors.set(filePath, message);
    console.warn(`[gryphon] Skill ${filePath}: ${message}`);
  }

  _isSkillFile(path) {
    return path.startsWith(`${SKILLS_DIR}/`) &&
           path.endsWith(".md") &&
           !path.endsWith("/README.md");
  }

  _removeByPath(path) {
    // Clear any tracked error for this file too — if the user deletes a
    // broken skill file, the error shouldn't persist.
    this.errors.delete(path);
    for (const [name, s] of this.skills) {
      if (s.path === path) { this.skills.delete(name); return; }
    }
  }

  _attachWatchers() {
    const vault = this.app.vault;
    const onCreate = vault.on("create", (file) => {
      if (file instanceof TFile && this._isSkillFile(file.path)) {
        this._loadFile(file);
      }
    });
    const onModify = vault.on("modify", async (file) => {
      if (file instanceof TFile && this._isSkillFile(file.path)) {
        this._removeByPath(file.path);
        await this._loadFile(file);
      }
    });
    const onDelete = vault.on("delete", (file) => {
      if (this._isSkillFile(file.path)) this._removeByPath(file.path);
    });
    const onRename = vault.on("rename", async (file, oldPath) => {
      if (this._isSkillFile(oldPath)) this._removeByPath(oldPath);
      if (file instanceof TFile && this._isSkillFile(file.path)) {
        await this._loadFile(file);
      }
    });
    this.eventRefs.push(onCreate, onModify, onDelete, onRename);
  }
}

module.exports = { SkillRegistry, parseSkillFile, SKILLS_DIR };

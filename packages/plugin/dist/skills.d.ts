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
import { TFile } from "obsidian";
import type { App, DataAdapter, EventRef } from "obsidian";
interface SkillEntry {
    name: string;
    description: string;
    argumentHint: string;
    body: string;
    path: string;
}
interface ParsedSkillFile {
    frontmatter: Record<string, string>;
    body: string;
}
declare const SKILLS_DIR = "Gryphon/Skills";
declare function parseSkillFile(text: string): ParsedSkillFile;
declare class SkillRegistry {
    app: App;
    skills: Map<string, SkillEntry>;
    errors: Map<string, string>;
    eventRefs: EventRef[];
    _pendingLoads: Set<Promise<void>>;
    _unloaded: boolean;
    constructor(app: App);
    /**
     * Returns currently-tracked skill load errors as an array of
     * { path, message } objects, ordered by path. Empty if all skill
     * files in Gryphon/Skills/ parsed successfully.
     */
    getErrors(): {
        path: string;
        message: string;
    }[];
    init(): Promise<void>;
    unload(): Promise<void>;
    effectiveSlashCommands(): ({
        cmd: string;
        desc: string;
        takesArgs: boolean;
    } | {
        cmd: string;
        desc: string;
        takesArgs?: undefined;
    })[];
    expand(name: string, args?: string | null): string | null;
    has(name: string): boolean;
    _ensureSkillsFolder(): Promise<void>;
    _migrateLegacyHermesFolder(adapter: DataAdapter): Promise<void>;
    _scanAll(): Promise<void>;
    _loadFile(file: TFile): Promise<void>;
    _doLoadFile(file: TFile): Promise<void>;
    _recordError(filePath: string, message: string): void;
    _isSkillFile(path: string): boolean;
    _removeByPath(path: string): void;
    _attachWatchers(): void;
}
export { SkillRegistry, parseSkillFile, SKILLS_DIR };

// TypeScript module marker.

/**
 * QA (2.11.2): the plain cause and the fix for each reason Gryphon refuses
 * to build Antigravity's Windows hook launcher. One table, used by every
 * notice that can report it — the dispatcher's two notices and the
 * Antigravity provider's refusal — so they never disagree or fall back to
 * "check hooks.json" when that isn't the problem.
 */
type RefusalText = { cause: string; fix: string };

// Short names: Windows only creates them for folders made after they're
// turned on, so "turn them on" can't fix an existing folder — giving that
// folder a short name (an administrator's `fsutil file setshortname`) can.
const SHORT_NAME_FIX =
  "An administrator can give that folder a short name with Windows' \"fsutil file setshortname\" command " +
  "(short names may first need turning on for the drive with \"fsutil 8dot3name set\"; turning them on alone " +
  "only affects folders made afterwards). Otherwise use a folder whose path has only plain English letters and " +
  "no spaces. Then start a new chat.";

/** Which folder a non-ASCII refusal is about, from the reason's suffix. */
const NON_ASCII_WHERE: Record<string, string> = {
  "vault and user folder": "the vault's folder path, and your Windows user folder,",
  "vault": "the vault's folder path",
  "user folder": "your Windows user folder",
  "node": "the folder Node.js is installed in",
};

const RULES: Array<[RegExp, RefusalText]> = [
  [/non-ascii/i, {
    cause: "a folder in the path has a letter (such as é) and Windows has no short name for that folder",
    fix: SHORT_NAME_FIX,
  }],
  [/percent or quote/i, {
    cause: "a folder name in the path contains % or a quote mark, which Windows can't pass to the checks",
    fix: "Rename that folder (or move the vault) so its path has no % or quote marks, then start a new chat.",
  }],
  [/no space-free location/i, {
    cause: "your Windows user folder has a space in its name and Windows has no short name for it",
    fix: SHORT_NAME_FIX,
  }],
  [/couldn't write the launcher/i, {
    cause: "Gryphon couldn't write the small launcher file for the checks",
    fix: "Make sure Gryphon's settings folder and your local app-data folder can be written, then start a new chat.",
  }],
];

/** The cause and fix for a launcher refusal named in `reason`, or null. */
function launcherRefusalText(reason: unknown): RefusalText | null {
  const r = String(reason || "");
  const where = /non-ascii path without a short name: (vault and user folder|vault|user folder|node)/i.exec(r);
  if (where) {
    const folder = NON_ASCII_WHERE[where[1].toLowerCase()];
    return {
      cause: `${folder} has a letter (such as é) and Windows has no short name for that folder`,
      fix: SHORT_NAME_FIX,
    };
  }
  for (const [re, text] of RULES) if (re.test(r)) return text;
  return null;
}

module.exports = { launcherRefusalText };

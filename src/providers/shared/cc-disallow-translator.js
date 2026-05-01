/**
 * Translator: Gryphon protected-pattern entries → Claude Code CLI
 * `--disallowedTools` glob rules (v0.5.6).
 *
 * Claude Code accepts tool-use deny rules of the form
 *   Bash(<glob>)         — deny bash commands whose command string matches
 *   Write(<glob>)        — deny writes whose file_path matches
 *   Edit(<glob>)         — deny edits whose file_path matches
 *
 * Gryphon's internal pattern language is different — path prefixes for
 * files, JS regex for commands. This module owns the (imperfect) mapping
 * from one into the other so the CLI provider stays free of glob trivia.
 *
 * Contract with the shared attack-detector:
 *   - When a translated glob actually prevents the tool-use, CC refuses
 *     it with a clear message to the model. No Gryphon modal fires (CC
 *     doesn't loop back to us). The user sees "can't run that — it
 *     matched a protected pattern" via the model's next turn.
 *   - When a user unchecks a default in Gryphon's settings, the
 *     corresponding rule is omitted from the `--disallowedTools` array
 *     the next time the CLI provider spawns (or resumes).
 *
 * Limitations (documented in CHANGELOG v0.5.6):
 *   - CC uses globs, not regex. Some Gryphon patterns (`\beval\b`,
 *     pipe-to-shell, etc.) map to multiple glob approximations that
 *     cover the most common forms but aren't literal translations.
 *     A sophisticated attacker could craft a command shape that evades
 *     the glob set; Anthropic API mode remains the authoritative protection in
 *     those cases.
 *   - CC denies outright; there's no approve-now UX in Claude Code mode. If
 *     the user wants to allow a flagged tool-use once, they must
 *     uncheck the pattern in Gryphon settings, re-ask the model, then
 *     re-check.
 *   - User-custom command regex: we extract a plain keyword and pass
 *     `Bash(*<keyword>*)` as a best-effort substring match. A user
 *     whose regex has no literal keyword gets no CLI-mode protection
 *     for that entry — documented as a known gap.
 */

const {
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_PROTECTED_COMMANDS,
} = require("../../constants");
const { resolveActivePatterns } = require("../anthropic-api/tools/path-utils");

/**
 * For each built-in protected-command regex we ship, this map supplies
 * the CC glob rules that approximate it. Keys are the raw regex
 * strings as stored in `DEFAULT_PROTECTED_COMMANDS[i].pattern`. Values
 * are arrays of glob rules.
 *
 * Adding a new default command pattern? Add its glob translation here
 * too — the CLI provider falls back to a generic `Bash(*<keyword>*)`
 * attempt for unmapped patterns, which is strictly worse than an
 * intentional translation.
 */
const CC_GLOBS_FOR_COMMAND_PATTERN = new Map([
  ["\\|\\s*(bash|sh|zsh|fish|tcsh|csh|ksh|python[\\d.]*|ruby|perl|node)\\b", [
    "Bash(*|*bash*)", "Bash(*|*sh*)", "Bash(*|*zsh*)", "Bash(*|*fish*)",
    "Bash(*|*tcsh*)", "Bash(*|*csh*)", "Bash(*|*ksh*)",
    "Bash(*|*python*)", "Bash(*|*ruby*)", "Bash(*|*perl*)", "Bash(*|*node*)",
  ]],
  // Indirected pipe-to-shell (path/quote/continuation forms). CC globs
  // are a shape-approximation — the canonical shapes (`| /bin/sh`,
  // `| "sh"`) map to the same glob set as the direct form.
  ["\\|(?:\\s|\\\\\\r?\\n)*['\"]?(?:/\\S+/)?['\"]?(bash|sh|zsh|fish|tcsh|csh|ksh|python[\\d.]*|ruby|perl|node)['\"]?\\b", [
    "Bash(*|*/bin/sh*)",   "Bash(*|*/bin/bash*)",
    "Bash(*|*/usr/bin/sh*)", "Bash(*|*/usr/bin/bash*)",
    "Bash(*|*\"sh\"*)",    "Bash(*|*'sh'*)",
    "Bash(*|*\"bash\"*)",  "Bash(*|*'bash'*)",
  ]],
  ["\\|\\s*\\$\\{?SHELL\\}?\\b", [
    "Bash(*|*$SHELL*)", "Bash(*|*${SHELL}*)",
  ]],
  ["(curl|wget)[^|]*\\|\\s*(bash|sh|zsh|fish|tcsh|csh|ksh)\\b", [
    "Bash(curl*|*bash*)", "Bash(wget*|*bash*)",
    "Bash(curl*|*sh*)",   "Bash(wget*|*sh*)",
  ]],
  ["\\b['\"]?rm['\"]?\\s+-[a-z]*r[a-z]*\\b", [
    "Bash(rm -r*)", "Bash(rm -R*)",
    "Bash(*rm -r*)", "Bash(*rm -R*)",
    "Bash('rm' -r*)", "Bash(\"rm\" -r*)",
  ]],
  ["\\b['\"]?rm['\"]?\\s+\\S", [
    "Bash(rm *)", "Bash(*rm *)",
    "Bash('rm' *)", "Bash(\"rm\" *)",
  ]],
  // Windows destructive commands. CC's `--disallowedTools` flag only
  // accepts `Bash(glob)` / `Write(glob)` / `Edit(glob)` rules — there's
  // no `PowerShell(glob)` form — so these globs only help when CC
  // routes a Windows-shaped command through its Bash tool (e.g. under
  // WSL). When CC on Windows uses its native PowerShell tool, this
  // fallback path can't reach it and the hook-based classify (which
  // DOES cover PowerShell — see attack-detector.js) is the only
  // protection. Kept here for the Bash-tool path so the pattern set
  // isn't wholly dark in the --disallowedTools fallback.
  ["\\bRemove-Item\\b[^|\\r\\n]{0,512}-Recurse\\b", [
    "Bash(Remove-Item*-Recurse*)", "Bash(*Remove-Item*-Recurse*)",
  ]],
  ["\\b(Remove-Item|ri)\\s+\\S", [
    "Bash(Remove-Item *)", "Bash(*Remove-Item *)",
    "Bash(ri *)", "Bash(*ri *)",
  ]],
  ["\\b(del|erase)\\s+\\S", [
    "Bash(del *)", "Bash(erase *)",
    "Bash(*del *)", "Bash(*erase *)",
  ]],
  ["\\b(del|erase)\\s+[^|\\r\\n]{0,512}\\/[sS]\\b", [
    "Bash(del /s*)", "Bash(del /S*)", "Bash(*del /s*)", "Bash(*del /S*)",
    "Bash(erase /s*)", "Bash(erase /S*)",
  ]],
  ["\\b(rd|rmdir)\\s+[^|\\r\\n]{0,512}\\/[sS]\\b", [
    "Bash(rd /s*)", "Bash(rd /S*)", "Bash(rmdir /s*)", "Bash(rmdir /S*)",
    "Bash(*rd /s*)", "Bash(*rmdir /s*)",
  ]],
  ["\\bformat\\s+[A-Za-z]:", [
    "Bash(format *:*)", "Bash(*format *:*)",
  ]],
  ["\\bFormat-Volume\\b", [
    "Bash(Format-Volume*)", "Bash(*Format-Volume*)",
  ]],
  ["\\|\\s*(Invoke-Expression|iex)\\b", [
    "Bash(*|*Invoke-Expression*)", "Bash(*|*iex*)",
  ]],
  ["\\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\\b[^|]{0,1024}\\|\\s*(Invoke-Expression|iex)\\b", [
    "Bash(Invoke-WebRequest*|*iex*)", "Bash(iwr*|*iex*)",
    "Bash(Invoke-RestMethod*|*iex*)", "Bash(irm*|*iex*)",
    "Bash(curl*|*Invoke-Expression*)", "Bash(wget*|*Invoke-Expression*)",
  ]],
  ["\\breg\\s+(delete|add|import)\\b", [
    "Bash(reg add*)", "Bash(reg delete*)", "Bash(reg import*)",
    "Bash(*reg add*)", "Bash(*reg delete*)",
  ]],
  ["\\bSet-Item(Property)?\\b[^|\\r\\n]{0,512}HK(LM|CU|CR|U|CC):", [
    "Bash(Set-Item*HKLM:*)", "Bash(Set-Item*HKCU:*)",
    "Bash(Set-ItemProperty*HKLM:*)", "Bash(Set-ItemProperty*HKCU:*)",
  ]],
  ["(>|>>|tee)\\s+\\S*\\.(obsidian|git|claude|vscode)[/\\\\]", [
    "Bash(*>*.obsidian/*)", "Bash(*>*.git/*)",
    "Bash(*>*.claude/*)",   "Bash(*>*.vscode/*)",
    "Bash(*tee*.obsidian/*)", "Bash(*tee*.git/*)",
    "Bash(*tee*.claude/*)",   "Bash(*tee*.vscode/*)",
  ]],
  ["(>|>>|tee)\\s+\\S*(~/\\.claude|~/\\.config/|~/\\.ssh/|~/\\.bashrc|~/\\.zshrc|~/\\.profile|/etc/|/usr/|/System/|/var/)", [
    "Bash(*>*~/.claude*)",  "Bash(*>*~/.config/*)",
    "Bash(*>*~/.ssh/*)",    "Bash(*>*~/.bashrc*)",
    "Bash(*>*~/.zshrc*)",   "Bash(*>*~/.profile*)",
    "Bash(*>*/etc/*)",      "Bash(*>*/usr/*)",
    "Bash(*>*/System/*)",   "Bash(*>*/var/*)",
    "Bash(*tee*/etc/*)",    "Bash(*tee*/usr/*)",
  ]],
  ["(>|>>|tee)\\s+\\S{0,512}[/\\\\](AppData|Windows|ProgramData|System32|Program Files|\\.claude)[/\\\\]", [
    "Bash(*>*\\AppData\\*)",       "Bash(*>*\\Windows\\*)",
    "Bash(*>*\\ProgramData\\*)",   "Bash(*>*\\System32\\*)",
    "Bash(*>*\\Program Files*)",   "Bash(*>*\\.claude\\*)",
  ]],
  ["\\bschtasks\\s+\\/(create|change|delete)\\b", [
    "Bash(schtasks /create*)", "Bash(schtasks /change*)", "Bash(schtasks /delete*)",
    "Bash(*schtasks /create*)", "Bash(*schtasks /change*)", "Bash(*schtasks /delete*)",
  ]],
  ["\\b(Register|Set|Unregister)-ScheduledTask\\b", [
    "Bash(Register-ScheduledTask*)", "Bash(Set-ScheduledTask*)", "Bash(Unregister-ScheduledTask*)",
    "Bash(*-ScheduledTask*)",
  ]],
  ["\\bStart-Process\\b[\\s\\S]{0,512}-Verb\\s+(['\"]?)RunAs\\1\\b", [
    "Bash(Start-Process*-Verb RunAs*)", "Bash(*Start-Process*-Verb RunAs*)",
    "Bash(*-Verb RunAs*)",
    "Bash(*-Verb 'RunAs'*)", "Bash(*-Verb \"RunAs\"*)",
  ]],
  ["\\bsc\\.exe\\s+(create|config|delete)\\b", [
    "Bash(sc.exe create*)", "Bash(sc.exe config*)", "Bash(sc.exe delete*)",
    "Bash(*sc.exe create*)", "Bash(*sc.exe config*)", "Bash(*sc.exe delete*)",
  ]],
  ["\\bNew-Service\\b", [
    "Bash(New-Service*)", "Bash(*New-Service*)",
  ]],
  ["\\b(Set-Content|Out-File|Add-Content|Export-Clixml)\\b[^\\r\\n]{0,512}[/\\\\](AppData|Windows|ProgramData|System32|Program Files|\\.claude)[/\\\\]", [
    "Bash(*Set-Content*AppData*)",    "Bash(*Set-Content*Windows*)",
    "Bash(*Set-Content*ProgramData*)", "Bash(*Set-Content*System32*)",
    "Bash(*Set-Content*.claude*)",
    "Bash(*Out-File*AppData*)",       "Bash(*Out-File*Windows*)",
    "Bash(*Out-File*ProgramData*)",   "Bash(*Out-File*System32*)",
    "Bash(*Out-File*.claude*)",
    "Bash(*Add-Content*AppData*)",    "Bash(*Add-Content*Windows*)",
    "Bash(*Export-Clixml*AppData*)",
  ]],
  ["\\bschtasks\\s+\\/run\\b", [
    "Bash(schtasks /run*)", "Bash(*schtasks /run*)",
  ]],
  ["\\|\\s*(/usr/bin/)?env\\s+(bash|sh|zsh|fish|tcsh|csh|ksh|python[\\d.]*|ruby|perl|node)\\b", [
    "Bash(*|*env bash*)",   "Bash(*|*env sh*)",
    "Bash(*|*env python*)", "Bash(*|*env node*)",
    "Bash(*|*env ruby*)",   "Bash(*|*env perl*)",
  ]],
  ["\\bchmod\\s+\\+x\\b", [
    "Bash(chmod +x*)",  "Bash(*chmod +x*)",
  ]],
  ["\\bgit\\s+(config|hooks)\\b", [
    "Bash(git config*)", "Bash(*git config*)",
    "Bash(git hooks*)",  "Bash(*git hooks*)",
  ]],
  ["\\b(sudo|su|doas|pkexec)\\b", [
    "Bash(sudo *)", "Bash(sudo\t*)", "Bash(*sudo *)",
    "Bash(su *)",   "Bash(*su *)",
    "Bash(doas *)", "Bash(*doas *)",
    "Bash(pkexec *)", "Bash(*pkexec *)",
  ]],
  ["\\beval\\b", [
    "Bash(eval *)", "Bash(*eval *)",
  ]],
  ["\\b(bash|sh|zsh|fish|tcsh|csh|ksh)\\s+-c\\b", [
    "Bash(bash -c*)", "Bash(sh -c*)",   "Bash(zsh -c*)",  "Bash(fish -c*)",
    "Bash(tcsh -c*)", "Bash(csh -c*)",  "Bash(ksh -c*)",
    "Bash(*bash -c*)", "Bash(*sh -c*)", "Bash(*zsh -c*)",
  ]],
  ["\\b(python[\\d.]*|ruby|perl|node)(\\.exe)?\\b[^|\\r\\n]{0,128}\\s-(c|e|-eval)\\b", [
    "Bash(python -c*)", "Bash(python3 -c*)", "Bash(python3.11 -c*)",
    "Bash(python -e*)", "Bash(python* -c*)", "Bash(python* -e*)",
    "Bash(ruby -c*)",   "Bash(ruby -e*)",
    "Bash(perl -c*)",   "Bash(perl -e*)",   "Bash(perl * -e*)",
    "Bash(node -c*)",   "Bash(node -e*)",   "Bash(node --eval*)",
  ]],
  ["\\b(python[\\d.]*|ruby|perl|node)(\\.exe)?\\b\\s+<\\s*\\S", [
    "Bash(python <*)",  "Bash(python3 <*)", "Bash(python* <*)",
    "Bash(ruby <*)",    "Bash(perl <*)",    "Bash(node <*)",
  ]],
  ["\\b(bash|sh|zsh|fish|tcsh|csh|ksh)\\s+<\\(", [
    "Bash(bash <(*)",   "Bash(sh <(*)",     "Bash(zsh <(*)",
    "Bash(*bash <(*)",  "Bash(*sh <(*)",
  ]],
  ["\\bxargs\\b", [
    "Bash(xargs *)", "Bash(*xargs *)", "Bash(*| xargs*)",
  ]],
  ["-exec\\b", [
    "Bash(* -exec *)", "Bash(*-exec *)",
  ]],
  ["\\bssh\\s+\\S+\\s+\\S", [
    "Bash(ssh * *)",
  ]],
  ["\\b(nohup|setsid)\\b", [
    "Bash(nohup *)", "Bash(*nohup *)",
    "Bash(setsid *)", "Bash(*setsid *)",
  ]],
  ["\\b(at|batch|crontab)\\b", [
    "Bash(at *)", "Bash(batch *)", "Bash(crontab *)", "Bash(*crontab *)",
  ]],
  ["\\bcurl\\b[^|\\r\\n]{0,512}://", [
    "Bash(curl*://*)", "Bash(*curl*://*)",
  ]],
  ["\\bwget\\b[^|\\r\\n]{0,512}://", [
    "Bash(wget*://*)", "Bash(*wget*://*)",
  ]],
  ["\\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\\b[^|\\r\\n]{0,512}://", [
    "Bash(Invoke-WebRequest*://*)", "Bash(iwr*://*)",
    "Bash(Invoke-RestMethod*://*)", "Bash(irm*://*)",
  ]],
  ["\\bStart-BitsTransfer\\b", [
    "Bash(Start-BitsTransfer*)", "Bash(*Start-BitsTransfer*)",
  ]],
  ["\\bNew-Object\\s+[^|\\r\\n]{0,64}Net\\.WebClient\\b", [
    "Bash(*New-Object*Net.WebClient*)",
    "Bash(*New-Object*System.Net.WebClient*)",
  ]],
  ["\\bcertutil(\\.exe)?\\b[^|\\r\\n]{0,512}-urlcache\\b", [
    "Bash(certutil*-urlcache*)", "Bash(certutil.exe*-urlcache*)",
    "Bash(*certutil*-urlcache*)",
  ]],
  ["\\b(fetch|axel|aria2c)\\b[^|\\r\\n]{0,512}://", [
    "Bash(fetch*://*)", "Bash(axel*://*)", "Bash(aria2c*://*)",
  ]],
  ["(\\bsource\\s+\\S+|(^|\\s)[.&]\\s+\\S+\\.(sh|bash|zsh|ps1|psm1))", [
    "Bash(source *)", "Bash(*source *)",
    "Bash(. */*.sh)", "Bash(. */*.bash)", "Bash(. */*.zsh)",
    "Bash(. */*.ps1)", "Bash(. */*.psm1)",
    "Bash(& */*.ps1)", "Bash(& */*.psm1)",
  ]],
  ["\\b(IEX|Invoke-Expression)\\b", [
    "Bash(*IEX*)", "Bash(*Invoke-Expression*)",
  ]],
  ["\\b(powershell|pwsh)(\\.exe)?\\s+-(c|com|comm|comma|comman|command|e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\\b", [
    "Bash(powershell -c*)", "Bash(powershell -Command*)",
    "Bash(powershell -e*)", "Bash(powershell -enc*)",
    "Bash(powershell -EncodedCommand*)",
    "Bash(powershell.exe -c*)", "Bash(powershell.exe -e*)",
    "Bash(pwsh -c*)", "Bash(pwsh -Command*)",
    "Bash(pwsh -e*)", "Bash(pwsh -enc*)",
    "Bash(*powershell*-c*)", "Bash(*powershell*-enc*)",
  ]],
  ["\\b(cp|mv|ln|install)\\b[^|\\r\\n]{0,512}\\s(~/\\.claude|~/\\.config/|~/\\.ssh/|~/\\.bashrc|~/\\.zshrc|~/\\.profile|/etc/|/usr/|/System/|/var/|/root/)", [
    "Bash(cp */etc/*)", "Bash(mv */etc/*)", "Bash(ln */etc/*)", "Bash(install */etc/*)",
    "Bash(cp */usr/*)", "Bash(mv */usr/*)",
    "Bash(cp */var/*)", "Bash(mv */var/*)",
    "Bash(cp */System/*)", "Bash(mv */System/*)",
    "Bash(cp *~/.ssh/*)", "Bash(cp *~/.bashrc*)", "Bash(cp *~/.zshrc*)",
  ]],
  ["\\bsed\\s+-i\\S*\\s+[^|\\r\\n]{0,512}(~/\\.claude|~/\\.config/|~/\\.ssh/|~/\\.bashrc|~/\\.zshrc|~/\\.profile|/etc/|/usr/|/System/|/var/|/root/)", [
    "Bash(sed -i* */etc/*)", "Bash(sed -i* */usr/*)", "Bash(sed -i* */var/*)",
    "Bash(sed -i* *~/.ssh/*)", "Bash(sed -i* *~/.bashrc*)",
  ]],
  ["\\b(Copy-Item|Move-Item|New-Item|Rename-Item)\\b[^|\\r\\n]{0,512}[/\\\\](AppData|Windows|ProgramData|System32|Program Files|\\.claude)[/\\\\]", [
    "Bash(Copy-Item*AppData*)", "Bash(Copy-Item*Windows*)", "Bash(Copy-Item*ProgramData*)",
    "Bash(Move-Item*AppData*)", "Bash(Move-Item*Windows*)",
    "Bash(New-Item*AppData*)", "Bash(New-Item*Windows*)", "Bash(New-Item*System32*)",
    "Bash(Rename-Item*AppData*)", "Bash(Rename-Item*Windows*)",
    "Bash(*Copy-Item*.claude*)", "Bash(*New-Item*.claude*)",
  ]],
  ["\\b(Copy-Item|New-Item|New-ItemProperty)\\b[^|\\r\\n]{0,512}HK(LM|CU|CR|U|CC):", [
    "Bash(Copy-Item*HKLM:*)", "Bash(Copy-Item*HKCU:*)",
    "Bash(New-Item*HKLM:*)", "Bash(New-Item*HKCU:*)",
    "Bash(New-ItemProperty*HKLM:*)", "Bash(New-ItemProperty*HKCU:*)",
  ]],
  ["\\b(shred|unlink)\\b", [
    "Bash(shred *)", "Bash(*shred *)",
    "Bash(unlink *)", "Bash(*unlink *)",
  ]],
  ["\\btruncate\\s+-s\\s+0\\b", [
    "Bash(truncate -s 0*)", "Bash(*truncate -s 0*)",
  ]],
  ["\\bdd\\b[^|\\r\\n]{0,512}\\bof=/dev/(sd|hd|nvme|disk|rdisk|md|loop|xvd|vd|mmcblk)", [
    "Bash(dd *of=/dev/sd*)", "Bash(dd *of=/dev/hd*)",
    "Bash(dd *of=/dev/nvme*)", "Bash(dd *of=/dev/disk*)",
    "Bash(dd *of=/dev/rdisk*)", "Bash(dd *of=/dev/md*)",
    "Bash(dd *of=/dev/loop*)", "Bash(dd *of=/dev/xvd*)",
    "Bash(dd *of=/dev/vd*)", "Bash(dd *of=/dev/mmcblk*)",
    "Bash(*dd *of=/dev/sd*)", "Bash(*dd *of=/dev/nvme*)",
  ]],
  ["\\bfind\\b[^|\\r\\n]{0,512}-delete\\b", [
    "Bash(find *-delete*)", "Bash(*find *-delete*)",
  ]],
  ["\\bmshta(\\.exe)?\\b", [
    "Bash(mshta *)", "Bash(mshta.exe *)", "Bash(*mshta *)",
  ]],
  ["\\brundll32(\\.exe)?\\b[^|\\r\\n]{0,256}(javascript:|://)", [
    "Bash(rundll32*javascript:*)", "Bash(rundll32.exe*javascript:*)",
    "Bash(rundll32*://*)", "Bash(rundll32.exe*://*)",
  ]],
  ["\\bregsvr32(\\.exe)?\\b[^|\\r\\n]{0,256}(scrobj\\.dll|/i:\\S+://)", [
    "Bash(regsvr32*scrobj.dll*)", "Bash(regsvr32.exe*scrobj.dll*)",
    "Bash(regsvr32*/i:*://*)", "Bash(regsvr32.exe*/i:*://*)",
  ]],
  ["\\bwmic\\b[^|\\r\\n]{0,256}\\bcall\\s+create\\b", [
    "Bash(wmic*call create*)", "Bash(*wmic*call create*)",
  ]],
  ["\\bpip[\\d.]*\\s+install\\b", [
    "Bash(pip install*)", "Bash(pip3 install*)", "Bash(pip3.11 install*)",
    "Bash(*pip install*)", "Bash(*pip3 install*)",
  ]],
]);

/**
 * Translate one protected PATH entry (plain string or { pattern, ... }
 * object) into CC glob rules for the Write and Edit tools.
 */
function _globsForPath(entry) {
  const pattern = typeof entry === "string" ? entry : (entry && entry.pattern);
  if (typeof pattern !== "string" || !pattern) return [];
  const norm = pattern.replace(/\\/g, "/");
  if (norm.endsWith("/")) {
    // Directory prefix — match everything under it.
    return [
      `Write(${norm}**)`,
      `Edit(${norm}**)`,
      `Write(${norm.slice(0, -1)})`,  // also the bare-folder path
      `Edit(${norm.slice(0, -1)})`,
    ];
  }
  // Exact file — match that path exactly.
  return [
    `Write(${norm})`,
    `Edit(${norm})`,
  ];
}

/**
 * Extract a rough keyword from a custom user regex so we can at least
 * make an attempt at a glob rule. We look for the first contiguous
 * run of alphanumerics (plus `-`, `/`, `.`) that's longer than 2
 * characters — that's usually enough to catch a prefix or command
 * name. If nothing clean comes out, return "" so the caller skips.
 */
function _extractKeyword(regex) {
  if (typeof regex !== "string") return "";
  // Strip common regex metacharacters before extracting the keyword.
  const stripped = regex
    .replace(/\\[bBsSwWdD]/g, " ")   // word/whitespace metachars
    .replace(/\\\s/g, " ")
    .replace(/[(){}\[\]^$+*?|.\\]/g, " ");
  const match = stripped.match(/[A-Za-z0-9\-\/][A-Za-z0-9\-\/\.]{1,}/);
  return match ? match[0] : "";
}

function _globsForCommand(entry) {
  const pattern = typeof entry === "string" ? entry : (entry && entry.pattern);
  if (typeof pattern !== "string" || !pattern) return [];
  const mapped = CC_GLOBS_FOR_COMMAND_PATTERN.get(pattern);
  if (mapped && mapped.length) return [...mapped];
  const keyword = _extractKeyword(pattern);
  if (keyword) return [`Bash(*${keyword}*)`];
  return [];
}

/**
 * Build the full CC `--disallowedTools` glob array for the user's
 * active protected-pattern selections.
 *
 * @param {object} settings — plugin.settings
 * @returns {string[]}        — CC glob rules, empty if nothing active
 */
function buildDisallowedTools(settings) {
  if (!settings) return [];
  const activePaths = resolveActivePatterns(
    DEFAULT_PROTECTED_PATHS,
    settings.protectedPathsDisabled,
    settings.protectedPathsCustom,
  );
  const activeCommands = resolveActivePatterns(
    DEFAULT_PROTECTED_COMMANDS,
    settings.protectedCommandsDisabled,
    settings.protectedCommandsCustom,
  );
  const out = [];
  for (const p of activePaths) out.push(..._globsForPath(p));
  for (const c of activeCommands) out.push(..._globsForCommand(c));
  // Dedupe while preserving order (CC accepts dupes but the command
  // line stays readable without them).
  return [...new Set(out)];
}

module.exports = {
  buildDisallowedTools,
  // Exported for unit tests only:
  _globsForPath,
  _globsForCommand,
  _extractKeyword,
  CC_GLOBS_FOR_COMMAND_PATTERN,
};

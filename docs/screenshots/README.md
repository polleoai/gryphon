# Screenshots

Screenshots referenced from the project [README](../../README.md) live here. They're shipped in the public repo so the README renders the same on github.com as it does locally.

## Capture procedure (for maintainers)

These need to be captured manually against a real Obsidian vault. Suggested setup:

1. Use a fresh-looking vault (no personal notes visible)
2. Pick a clean Obsidian theme (default Obsidian or Minimal looks good in screenshots)
3. Enable Gryphon; toggle to "Open in main tab" so the chat takes the full pane
4. Capture each scene below at retina resolution (1× exported at 2×)
5. Resize to 1600px wide (keeps retina sharpness at GitHub's ~800px README column, halves the byte count):
   ```
   for f in *.png; do sips --resampleWidth 1600 "$f" --out "$f.tmp" && mv "$f.tmp" "$f"; done
   ```
6. Lossless-compress with oxipng (`brew install oxipng`):
   ```
   oxipng -o 4 --strip safe *.png
   ```
   Target: each PNG ≤ 300 KB after both steps. ≤ 200 KB is ideal but not required; sharp text is worth a bit more.
7. Commit to `docs/screenshots/`

## Required scenes

| File | Scene |
|---|---|
| `chat.png` | A chat in mid-flight: user message at top, streaming assistant response below, status bar showing token usage |
| `settings.png` | Settings tab scrolled to **Security** section — Provider dropdown showing "SDK (recommended)", the two master toggles (Protect file paths / Protect commands) visible with pattern checklists beneath. This is the positioning-differentiator screenshot; make it easy to see the curated pattern list. |
| `permission-modal.png` | The Edit-tool permission modal triggered by Claude editing a vault file. Should show the diff preview. **New:** capture one modal variant triggered by a *protected* pattern (e.g. `rm -rf`) so the risk-context wording is visible — it's distinct from a normal approval modal. |
| `welcome.png` | The first-run welcome panel (toggle Gryphon off + clear API key + clear claude binary path to reproduce) |

## Optional / nice-to-have

| File | Scene |
|---|---|
| `skills-folder.png` | Obsidian file tree showing `Gryphon/Skills/` with a few `.md` skill files |
| `slash-autocomplete.png` | The slash-command dropdown above the input, showing built-in + skill commands |
| `help-modal.png` | The /help modal with all shortcuts and commands |

## Conventions

- **Filename:** lowercase-with-hyphens, `.png` extension
- **Aspect ratio:** prefer landscape (~1600x900 or 1280x720) for chat scenes; portrait OK for sidebar shots
- **Privacy:** double-check no personal vault content is visible (file names, note bodies, paths)
- **Theming:** stick to default Obsidian theme so visuals look consistent across users

## Why placeholders ship before the real images

The README's screenshot table renders broken-image icons until real PNGs exist here. That's intentional — it makes "ship screenshots" a visible TODO instead of an invisible one. When the public release goes out, all four required scenes need to be present.

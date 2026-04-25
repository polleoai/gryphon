# Gryphon — Changelog

All notable changes to the Gryphon Obsidian plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

> **Project history:** This plugin was originally developed as **Hermes** through pre-1.0 milestones and was briefly published under that name at v1.0.0. It was renamed to **Gryphon** in 2026-04 to avoid confusion with the unrelated Hermes agentic system. The Gryphon v1.0.0 release is the same code as the Hermes v1.0.0 release with a name change. CHANGELOG entries below referencing "Hermes" reflect what the project was called at the time of those releases.

## [1.0.0] — 2026-04-25

Renamed to Gryphon. Functionally identical to Hermes v1.0.0; this release is the canonical v1.0.0 going forward, with a one-step migration path for the small number of users who installed Hermes v1.0.0 in the brief window before the rename.

- All `Hermes` references in the plugin replaced with `Gryphon`: plugin id, display name, vault folder, viewType, CSS classes, log prefixes, internal constants
- Vault folder migration: existing `Hermes/` folder is auto-renamed to `Gryphon/` on first launch, preserving skills, exports, and MANUAL.md
- Settings migration: hand-copy `.obsidian/plugins/hermes/data.json` → `.obsidian/plugins/gryphon/data.json` (settings are unencrypted JSON)
- All other behavior unchanged from Hermes v1.0.0 — same security model, same providers, same hook surface, same protected patterns


---

This is the first public release. Subsequent releases will be added
above as they ship.

---
name: Feature request
about: Suggest an idea or improvement
title: ""
labels: enhancement
assignees: ""
---

## What you want

A clear description of the feature or improvement.

## Why it matters

What problem does it solve, or what experience does it improve? If you've worked around it, describe the workaround.

## Proposed approach (optional)

If you have an idea of how it could be implemented, share it. The maintainer will weigh approaches against the project's scope (see README and CONTRIBUTING).

## Scope check

Gryphon is intentionally minimal — a chat surface for Claude with vault-aware tools. Features that match this scope are most likely to land:
- New tools that work in SDK mode (and ideally have CC parity)
- UX improvements to chat, settings, or skills
- Provider improvements (CLI args, SDK options, error handling)

Features that probably don't fit:
- Authoring environments (notes, code editors) — Obsidian and other tools handle these
- General-purpose RAG / vector search — out of scope for this plugin
- Non-Anthropic providers as primary path (would need a strong rationale)

If you're unsure whether your idea fits, open the issue anyway — the conversation is the value.

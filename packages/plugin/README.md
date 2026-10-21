# @polleoai/gryphon-plugin

The Gryphon Obsidian plugin's chat view, settings and skills, packaged for apps that embed Gryphon in their own Obsidian plugin.

**Using Obsidian?** You don't need this package — install Gryphon from Obsidian's Community Plugins, or see https://github.com/polleoai/gryphon.

## What's inside

- The chat view (`@polleoai/gryphon-plugin/chat-view`) — subclass it or configure it through its options to fit your plugin.
- Settings, constants and skills (`./settings-view`, `./constants`, `./skills`).
- Built on the other Gryphon packages: [`@polleoai/gryphon-protect`](https://www.npmjs.com/package/@polleoai/gryphon-protect) (guardrails), [`@polleoai/gryphon-provider-runtime`](https://www.npmjs.com/package/@polleoai/gryphon-provider-runtime) (AI providers) and [`@polleoai/gryphon-provider-config`](https://www.npmjs.com/package/@polleoai/gryphon-provider-config) (models and pricing).

`obsidian` is a peer dependency: your plugin provides it.

## License

MIT — see `LICENSE`. Source and issues: https://github.com/polleoai/gryphon

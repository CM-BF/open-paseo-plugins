# Original Cindy settings slice

This private web package builds a sandboxed React DOM settings drawer for the Paseo plugin. It retains Cindy's settings component, drawer, autosave/leave guards, theme tokens, numeric Tailwind scales, original primitives, profile, personality, memory, capability, routine, history, voice and messaging UI. It excludes the full desktop app and Projects. The Paseo client imports only `client/generated/settings-html.ts`; DOM modules never enter its React Native bundle.

```sh
cd plugins/cindy-companion/web
npm ci
npm test
npm run build
node collect-notices.mjs
```

To refresh the selected original files: `node import-upstream.mjs /path/to/pinned/cindy`. Preserve and review the transformations in that script. See [SOURCE.md](SOURCE.md), [LICENSE-CINDY](LICENSE-CINDY), [NOTICE-CINDY](NOTICE-CINDY) and [third-party notices](licenses/THIRD-PARTY.md).

The frame requests RPC through `{channel:'cindy-companion',type:'request',id,op,args}` and only accepts replies from `window.parent`. It emits `ready`; the host replies with `init` containing botId, host, theme, locale. Requests and responses preserve real backend failures. `request-close` enters the original autosave/leave guard before the frame emits `close`. `navigate-agent` contains agentId. The host owns the 448px drawer frame, blurred scrim and chat navigation. The frame uses memory-only display caches, since `allow-scripts` without `allow-same-origin` prevents localStorage.

Model selection uses the real Paseo provider catalog, `models.default`, and `models.features`. The original model-chain editor, task override, effort slider, speed toggle and Select controls remain; the full desktop UnifiedModelPanel is replaced by a scoped catalog adapter. Runtime `pending`, `unknown` and `error` states produce the original warning toast, so a saved profile is not represented as already applied to the current agent.

Voice and messaging retain their original page sources and expose disconnected states until a real host service is connected. They do not simulate saved preferences, connections, previews or playback. Projects, remote transfers, global provider/tool setup, invitation cloud flow and Cindy's cloud services are outside this slice. Routines offer the original form; unsupported session modes and triggers must be rejected by the backend with a specific error. The voice session bridge is deliberately paused until real permission/active-session state is available.

The raw HTML embeds styles and the public portrait gallery. The generated host document carries gzip-compressed HTML and restores it with native DecompressionStream. Complete original Huawei TTF files remain server-only: the frame fetches fixed 393216-byte chunks through assets.fontChunk, validates the complete SHA-256, then loads FontFace. All three original weights finish loading before the settings page mounts. Closing stops subsequent chunk requests and discards late replies. No fonts are transformed or subsetted; the build enforces a 20 MiB client transport budget and original file hashes. Original locale JSON contains upstream duplicate-key warnings; this package does not silently rewrite that content. Production bundling and protocol/state/autosave tests are verified independently of full desktop TypeScript declarations. Full original renderer type checking requires Cindy's omitted desktop/preload type graph. UI acceptance must use the actual running Paseo plugin; a synthetic fixture is not evidence of daemon integration or pixel parity.

The web build pins every declared runtime dependency to `web/node_modules` and fails if React, ReactDOM, or either router resolves to a second installation. Vendored source lives outside `web/`, so ancestor resolution alone can accidentally mix the host's React with the iframe's renderer. The vendor bundle regression renders the original hook-using Switch and Radix with the bundled ReactDOM; it is a runtime check, not visual acceptance. The host compiler separately imports only `client/` and `shared/`; avatar leaf utilities are copied under `shared/vendor/` with their source hashes.

Dependency security updates retain the same major versions: PostCSS 8.5.32, React Router DOM 7.18.5, and Zod 4.6.7. `collect-notices.mjs` reads actual paths from the fixed-working-directory build metafile, preserves each bundled package/version, and removes obsolete generated license directories.

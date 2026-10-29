# Cindy Companion for Paseo

A port of Cindy's core companion experience into a Paseo plugin, including its Teammates sidebar, original settings, preset catalog, group discussion and work cards. The ongoing scope is faithful placement, styling and behavior across the [28-feature inventory](CORE_FEATURES.md). Paseo's native agents and conversations remain the execution and chat surfaces. The inventory is not yet complete.

The original React settings components, styles, icons, avatar picker and memory logic come from [makecindy/cindy](https://github.com/makecindy/cindy), pinned to `118767c987f518286ae10a506a54287c3dc2a560`. Host adapters connect them to real Paseo agents and local companion data.

## Use

Basic companion settings require Paseo 0.13.2 or later. New group/work/task execution also requires the unreleased idle-admission API and an atomic provider implementation. Current production providers do not provide that guarantee, so this source explicitly leaves those new inputs unsent; upgrading only the SDK does not enable them. The currently installed first-wave version is documented separately in PROGRESS.md.

From a checkout, install the production dependencies before installing the plugin directory:

```sh
cd plugins/cindy-companion
npm ci --omit=dev --no-audit --no-fund
paseo plugin install "$PWD" --id cindy-companion
```

Keep this checkout available while it is installed. Local directory installation uses it directly; it does not run the manifest's build commands. Managed Git installation runs the declared production dependency step automatically.

- Click a teammate's avatar to open its persistent Paseo conversation.
- Open Settings from the teammate menu or its workspace header. Desktop and web use the original right drawer, at a maximum width of 448 px, with the original dark backdrop and blur.
- Profile, personality, user preferences and memory are stored locally. The advanced configuration folder contains `SOUL.md`, `USER.md` and the companion's memory files.
- The companion receives an authenticated, local MCP endpoint for current identity and memory. Settings and tools share the same storage. Disabling memory blocks the memory tools immediately.

## Current support

| Area | Behavior and limits |
| --- | --- |
| Identity and avatar | Original settings forms, presets, crop flow and local persistence. Existing sessions report pending changes when the host cannot update their instructions. |
| Conversation | One stable canonical Paseo agent per companion; repeated clicks reuse it. Missing or archived agents are reported instead of silently replaced. |
| Preset teammates | Ten original packages with durable invitation receipts, original skills/resources, authored welcome text and starter choices. Preset routines remain disabled until explicitly enabled. New market/create UI still requires installed acceptance. |
| Group discussion and work | Persistent groups, reply modes, original work-plan/task-card components, shared plan work directories and frozen result-file receipts. Native admission, exact stopping and cleanup remain subject to the limits below; this second-wave source is not installed or live-verified. |
| Companion tasks | Scoped task tools, persistent child/task ownership, queue/pause/resume/cancel state and original collaboration cards. Private parent completion delivery and named teammate direct messaging remain open. |
| Memory | Original file format and editing semantics, search, optimistic conflict checks, and MCP read/write tools. No Cindy account or cloud memory is copied. |
| Model | Actual Paseo provider catalogs, model, thinking and speed options. Updating an existing session requires the proposed public Paseo configuration APIs. Cross-provider replacement and automatic model fallback are not implemented. |
| Routines | Native Paseo schedules with one time trigger and a new task session. Other Cindy trigger and execution modes are rejected. |
| History | Searches linked native conversations, with a visible bounded-history limitation. |
| Voice and messaging | Original settings UI with explicit unavailable/disconnected states. Cindy cloud services and messaging transports are not connected. |
| Capabilities and computer transfer | No claim of Cindy's capability isolation or remote computer migration. Unsupported operations return errors. |
| Mobile | Teammate chat is available; the original HTML settings drawer currently requires desktop or web. |

The accompanying [Paseo draft PR #8168](https://github.com/getpaseo/paseo/pull/8168) exposes generic agent configuration, schedules, navigation, current-agent header contributions and guarded turn operations. These changes belong in Paseo; companion storage and Cindy UI stay in this plugin. On older hosts, the teammate selection ring follows clicks; hosts with the new API keep it synchronized with native navigation. [Upstream-watch PR #2](https://github.com/CM-BF/open-paseo-plugins/pull/2) separately tracks Cindy and proposes future changes without implementing them automatically.

Lost native acknowledgements remain uncertain across restart and are not inferred from an idle snapshot or automatically resent. An unavailable exact stop links to the recorded native conversation for manual action. Cleanup verifies an actual native archive; it never closes whichever user turn happens to be active. These are source-level guarantees under test, not production execution acceptance. See [PROGRESS.md](PROGRESS.md) for the exact installed source and remaining work.

## Development

```sh
npm ci
npm run typecheck
npm test
cd web
npm ci
npm test
cd ..
npm run build:web
npm run build:client
```

Commit the generated settings document, server font module, font manifest and client bundle/entry after rebuilding. The compressed HTML contains the original settings slice. Full, unmodified HarmonyOS font files stay in the server bundle and load through bounded RPC chunks when Settings opens; the frame verifies their byte counts and hashes before rendering the settings controls. This keeps the startup catalog within the relay transport budget. The client build lowers the host contribution for Hermes. Runtime installation needs only the root production dependencies; frontend build dependencies are separate.

The frame is sandboxed without same-origin access. Its bridge checks the source window and bounded messages; it receives no daemon credentials. The memory endpoint binds only to loopback, uses a separate token per companion, and keeps its endpoint secret in a mode-0600 file. These boundaries do not turn a trusted Paseo plugin into an untrusted-code sandbox.

## Attribution

Cindy Companion uses HarmonyOS Sans Fonts. Copyright 2021 Huawei Device Co., Ltd. The unmodified fonts are bundled under the [HarmonyOS Sans Fonts License Agreement](web/licenses/HarmonyOS-Sans-LICENSE_Fonts).

Cindy is developed by XD Inc. This is an independent port, not an official Cindy product. Retained upstream licenses and notices are in `web/` and `server/vendor/`; source provenance records distinguish reused code from the Paseo adapters. Third-party components and assets retain their respective terms.

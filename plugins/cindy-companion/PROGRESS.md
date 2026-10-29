# Cindy companion port

## Goal and decisions

Port Cindy's companion entry and settings as a plugin. The user's definition of fidelity is UI style, placement and functionality within the selected scope, not the whole Cindy application. Reuse upstream source instead of redrawing the settings page. Keep generic host changes in a separate Paseo PR.

Pinned Cindy source: `118767c987f518286ae10a506a54287c3dc2a560`.

The original sidebar avatar opens chat. Settings is a right drawer opened by the companion menu or chat header. The native Paseo conversation remains the chat surface. Original settings render in an isolated HTML frame; the host owns the backdrop and navigation. Companion storage, memory and agent bindings belong to the plugin.

## Work status

- Implemented: original settings slice and host bridge; Teammates sidebar; persistent profile, identity and avatar; stable canonical agent creation; shared memory service and authenticated loopback MCP; bounded native history search; native schedule adapter.
- Implemented with host dependency: model/thinking/speed updates and instruction refresh. Older hosts return explicit pending states. A separate Paseo branch adds the public APIs.
- Paseo draft PR: [getpaseo/paseo#8168](https://github.com/getpaseo/paseo/pull/8168), based on upstream `e12feb633`; head `51c1ad8f3`. It adds public model/schedule APIs, guarded instruction updates, navigation and host-scoped current-agent state.
- In progress: routine context-tool verification, actual desktop and narrow web UI acceptance, and the plugin PR. Clean production installation and the final live reload/font delivery checks passed.
- Open: full capability selection/isolation, model fallback runner, additional schedule modes, voice/messaging transports, remote computer migration and native mobile settings.

## Verification record — 2026-10-28

Source branch: `feat/cindy-port`; implementation commit `33627ca1fcad59962d40224177c52d00c40b65a0`, followed by installation documentation fixes. Main daemon: Paseo **0.13.2**, default home, loopback port **6767**. Plugin directory installation: the retained `Paseo-cindy-port/plugins/cindy-companion` checkout. No other plugin or daemon was restarted.

- TypeScript host typecheck passed.
- The final combined root suite passed 56 tests: 24 backend, 13 schedule, 7 real-HTTP MCP, 5 font chunk, 5 avatar and 2 frame protocol tests. Fixtures use isolated temporary storage; no provider starts in unit tests.
- MCP tests use the official client over real HTTP. They cover shared settings/tool storage, stale-update rejection, per-companion authentication, disabled memory, origin rejection, stable endpoint reuse, port-conflict recovery and admission/drain during shutdown.
- The final frontend adapter/save and actual exported component suite passed 31 tests. These include duplicate clicks, stale callbacks after host changes, native-navigation selection, frame teardown, guarded close, single-React rendering of an original hook component, compressed loading/error behavior, font integrity and cancellation before mounting settings. They use substituted host controls and do not prove native visual rendering.
- The actual installed Paseo compiler and a Hermes VM accepted the final generated client entry. The compiler preserved the compressed settings document (SHA-256 `201c4984ecdc04d02fef2efd6c9cd1396b8bad4d84024d5c090b0a3481f33505`) and all three original font payloads byte-for-byte. A clean `git archive` export of `33627ca` passed `npm ci --omit=dev`, the actual host compiler, font/document hash checks and Hermes with no frontend, React or Babel installation. The verification helper was corrected to recognize static template literals and frozen objects emitted by the compiler; no runtime code change was needed.
- Frontend dependency upgrades removed all findings in the npm audit report. Duplicate React runtimes in the extracted component bundle were fixed with a stable dependency root, a metafile assertion and an original-component render test. The root production dependency audit also reported zero findings.
- Manual routine execution now returns an accepted operation immediately instead of waiting for a whole model turn inside the 30-second plugin RPC. Repeated requests reuse the pending operation; uncertain results are reconciled against native history without automatically launching again. Failures remain visible and shutdown drains owned work.
- A real routine fixture received acceptance in 321 ms and native run status `success`. Its companion identity and authenticated MCP configuration were present in the created agent, but the actual timeline contained no context-tool call and the marker assertion failed. This is under investigation; native turn completion alone is not treated as functional acceptance. The exact fixture schedule and profile were removed and its agent archived, with cleanup verified in private evidence `routine-7e24e415-5552-4ffa-bfce-5f693a8d3f8a.json`.
- Font review replaced third-party subsets with the original Huawei TTF bytes and retained the actual agreement and usage notice. Full font embedding exceeded the relay catalog budget even with gzip, so the final design serves the fixed three-font allowlist in bounded RPC chunks, validates exact length/hash and loads with FontFace. Independent review reconstructed all 66 chunks with matching official bytes and checked cancellation/admission boundaries. The final client artifact is 6,024,613 bytes (SHA-256 `d0ff2c2f724a4865c2867474f538a5f38c4d4bbfe0f97440a87e0aa60f86c4ac`). After the final live reload, all 66 real RPC responses reassembled the three original fonts exactly; the largest result was 524,452 bytes.
- Final plugin-only reload passed a fresh ownership/idle gate after saving private data, settings and the previous client bundle. The plugin returned `running` and logs contained no startup errors. The served client was 6,028,160 bytes (SHA-256 `a21b850cd4500810ab7ad66542857872ae6dbc414b1a162bf159e4811ba2d3f9`). The entire live 37-plugin catalog measured 11,651,132 plaintext bytes, or 15,540,540 bytes after the Noise/base64 envelope calculation, below the 32 MiB relay message limit. This measures size; it does not claim an actual relay delivery test.
- Actual daemon installation and reload returned `running`. Real plugin bootstrap RPC returned the default Cindy profile and the daemon's provider catalog. No canonical agent had been created at that checkpoint.
- A subsequent real provider test passed using a dedicated companion and Codex Luna with low reasoning: `companion_context`, `memory_write` and `memory_read` all completed successfully in the native timeline. The settings RPC returned the same memory marker. The owned test write was explicitly approved; no unrelated tools ran. The fixture agent was then archived and its teammate removed through the plugin's lifecycle API; native history and the reversible local tombstone remain. Detailed evidence is stored privately under the default Paseo home's `verification/cindy-companion/` directory.
- UI acceptance is **not passed**. The computer tool could not bind a native Paseo window. The official `https://app.paseo.sh` page loaded in Chrome, but direct connections to both loopback address and localhost timed out. No security flags or daemon web UI configuration were changed. No settings screenshot is presented as verified output.

## Next

Resolve the routine context-tool verification gap, open the plugin draft PR, and complete right-drawer and persistent-edit acceptance when the actual app is accessible. Record exact fixture cleanup and screenshot evidence. Keep the installed directory available until the plugin is moved to a stable managed revision.

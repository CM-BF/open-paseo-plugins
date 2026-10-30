# Latest-state ingress and responsive capture verification

The installed source `0c7fab457f3283cb3bc0979f2e1abfa8ec33d2ca` was verified on the existing primary Paseo 0.14.0 daemon. Subsequent launch guidance and this report change documentation only. Installation uses the retained `~/.paseo/local-plugins/paseo-board/dev` directory, with source, runtime, settings and data backed up before replacement. The three existing Boards retained their canvas and saved state. No daemon or unrelated plugin was restarted.

## Accepted behavior

- `createFeed` / `feed.set` carry arbitrary latest JSON values to disjoint paths. The producer retains one pending request, generation and sequence; confirmed conflicts require explicit reconciliation. Quiet writes do not create unread navigation entries or wake agents. Milestones can locate their actual render targets.
- `board.watch(path, render)` immediately renders the selected value, then skips unrelated changes. It preserves authored rendering and controls; the frame transport still sends whole snapshots.
- `board_read` with `view: "inspect"` returns bounded persisted data, selected interactions, source status and update summaries. Full reads remain the default. Neither mode observes live browser pixels or errors.
- The selection composer opens before screenshot completion. Matching late pixels join the same draft; sending fixes the original payload and route. Geometry-planned capture prunes safely unrelated subtrees and yields between chunks of DOM work.

## Verification layers

| Layer | Result | Scope |
| --- | --- | --- |
| TypeScript and source tests | 168 tests in 12 files passed | State, source fencing, unknown outcomes, ordering, transport, inspection and prior behavior |
| Chromium BoardView | 29 scenarios passed | Real UI rendering with adapted Paseo transport/native primitives |
| Chromium canvas | 45 scenarios passed | Real runtime, pixels, subscriptions, retained controls and concurrency |
| Clean build | Zero reported npm audit vulnerabilities; byte-identical bundle | Archived source, Node 24.20.0, client build and static/Hermes evaluation |
| Installed producers | Seven checks passed | Three independent Node processes, restart, exact ACK replay, stale/gap rejection, manual edit and generation fencing |
| Fresh actual MCP owner | Three checks in two turns passed | Canonical create/open/set/inspect/respond calls, exact bound identity, latest-value response |
| Native Paseo desktop | Passed | Actual Board index, quiet refresh, retained typed input/focus, pointer-local composer, Enter send and rendered response |

The producer run is synthetic data from real processes, not three LLM agents or training. Lost-response recovery was fault-injected in source tests; the live process restart was orderly. Native desktop acceptance used a freshly created inexpensive model session after installation. A quiet update changed the displayed value from 41 to 73 while the typed input and focus survived and navigation remained at zero unread locations. The UI message then caused actual MCP inspection and a response with the exact new version, value and nonce. The same owner was archived after verification.

## Performance evidence

An isolated Chrome 156.0.8078.74 renderer loaded the actual Board document/runtime. The 6,763-element fixture was 2066 × 8216 pixels; these are local single-run measurements, not the user's remote document.

| Capture | Baseline | Final | SVG data URI | Final longest observed task |
| --- | --- | --- | --- | --- |
| 240 × 160 | 5,438 ms | 211 ms | 83.36 MB → 1.39 MB | No task ≥ 50 ms observed |
| 1400 × 750 | 4,099 ms | 799 ms | 83.36 MB → 5.41 MB | 86 ms |

The baseline small capture had a 5,258 ms main-thread task. Its second, large capture had warmed decoding and an unreliable long-task observation, so no large baseline blocking figure is claimed. The host test opened input within 21.5 ms while deliberately holding actual screenshot decoding; this is an adapted-transport measurement, not native timing.

At 1,699 / 6,763 / 13,515 page elements, final small captures took 142 / 211 / 311 ms; large captures took 730 / 799 / 875 ms. Native-reference pixel differences were 0.71% / 0.96% above a 20-channel-value threshold, within the explicit 1.5% text-rendering tolerance. Overlap, clipping, fixed/scrolled content and fresh Canvas/WebGL fixtures passed. A separate dense-text animation fixture uses a documented 4% font tolerance; its screenshot was byte-identical before/after stopping unrelated animation, which advanced 18 frames during capture.

DOM work remains on the main thread; SVG serialization and decoding still have cost. No native screenshot API or stale screenshot cache was introduced. Unsupported paint/layout or overly complex selected content explicitly retains geometry/text without a PNG. The selected clone limit is 1,800 elements, with a 3.5-second clone-work budget; an oversized fixture was rejected in 14 ms. Cancellation uses a separate fixture that proves capture began before abort and verifies restoration afterward.

## Inspection and launch usability

One actual development-Board read was 1,211,811 bytes; an inspect request for one data path, one interaction and three recent entries was 5,516 bytes. CLI durations were 514 ms / 438 ms, including process startup; this is a payload comparison, not a general latency guarantee.

The first live producer launch failed before creating a fixture because the async-shell MCP server does not inherit the caller's session environment. The successful retry used the existing public `paseo-shell register --env` route from the owning agent's ordinary shell. The generated skill and README now show this launch handoff. No new credential store, private cross-plugin read or permission bypass was added; producer journals never contain credentials.

## Evidence and limits

Private evidence is retained under `~/.paseo/verification/paseo-board/ingress-performance-20261030/`:

- `combined-latest.json` and `combined-1793400595024930000/`: integrated source/build receipts and raw logs.
- `capture/baseline-initial.json`, `capture/final.json`, `capture/pixels-final/`: performance and native-reference pixel pairs.
- `install-1793400696756-39be87.json`: installation identity, backup and preserved user Board hashes.
- `live-feed-1793400850239-d46504/receipt.json`: actual producer and independently stored evidence.
- `live-mcp-1793400859642-c0b967/receipt.json`, canonical tool records and `native-observation.json`: actual MCP and native UI acceptance.
- `native-development.json`, `live-inspect-comparison.json`: existing development-Board capture/input checks and inspection comparison.

Native accessibility state and screenshots were inspected in-session; unrelated sidebar content is not committed publicly. Desktop native acceptance is separate from compact and two-theme isolated renderer checks. Whole-file persistence and full-snapshot transport remain; no high-frequency streaming or unlimited event-history claim is made. Earlier failed setup/test runs remain alongside the accepted evidence.

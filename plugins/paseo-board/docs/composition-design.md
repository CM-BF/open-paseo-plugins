# Composable Board sources

The user approved plugin-only composition with the source hosts connected. A monitor or briefing is an ordinary agent-authored Board, using stable references, source inspection and managed embeds. No fixed dashboard layout or Paseo client change is part of this implementation.

## Contract

- Address sources by `{hostId, boardId}`. Public host-bound plugin capabilities provide transport; the parent never guesses a host from a title or falls back to its own host.
- Authors place `<paseo-board>` slots in ordinary HTML/CSS, choosing source, interactive or preview presentation, and dimensions. Parent state/content controls layout. Temporary view state belongs to each parent/slot/source instance.
- Each source retains its own data, authored controls, comments, owner and theme. Removing a slot removes only the reference. Parent and source comments have explicit, distinct targets.
- The user chooses which sources may be read by the parent agent. Source grants and synchronized inspections are stored separately from authored HTML/data/state. Authoring a slot cannot grant agent access to a new source.
- Each selection records the source's creation identity. Recreating a Board with the same ID requires a new selection; it cannot inherit a prior read grant, source frame or saved instance position.
- Agents can list and inspect the authorized sources through Board tools. Results include source revision, observation time and bounded history coverage. Connected clients synchronize cross-host inspections; same-host authorized reads can be current without the client relay.
- A passive embed or source inspection does not acknowledge user unread updates. Hidden previews must not run full interactive canvases without bounds.
- Original iframe/session guards remain in force. The managed child-frame mechanism requires a real browser proof for origin isolation and source-bound messages before integration. Parent screenshot/export must include source material correctly or explicitly report its limitation.

## Delivery sequence

1. Implement versioned, generation-fenced host transport and scope existing Board operations to it.
2. Prove a managed child frame in an actual authored slot. Implement bounded slot discovery, lifecycle, natural layout and precise child event routing.
3. Implement user-selected source grants, bounded inspection snapshots and agent discovery/read tools, with authorization and revision tests.
4. Integrate source selection and independent interactive/preview controllers. Preserve comments and drafts, allow free authored sizing and retain source identity during resize/reorder.
5. Add truthful authoring guidance and an agent-authored monitor/briefing example. Use durable fixed evidence for historical briefings; do not label current-source content as a historical snapshot.
6. Run focused then complete source/browser regression, build exact worker/client artifacts, verify Hermes and production packaging. Install only the tested revision after backup and live idle check, without restarting the daemon.
7. Verify actual Web behavior with dedicated fixtures on available authorized hosts and clean them up. A simulated second host is mechanism evidence, never real cross-host acceptance. Publish a separate draft PR; do not merge without explicit approval.

## Scope and outstanding validation

All-hosts-disconnected operation and a new unattended cross-host scheduling system are outside the requested first version. Losing the screen-owning host can unload a plugin screen under the current Paseo lifecycle. Public cross-host cooperation depends on compatible Board installations in the current app realm and is capability-checked.

The fixed candidate passed 516 source tests, 8 browser mechanism checks, 19 production CanvasFrame checks and 11 production BoardView checks. A subsequent single-comment acknowledgement regression passed 12 BoardView checks. Final review corrections, complete clean-archive regression and actual daemon acceptance remain separate stages. Only one real connected host has been observed; adapted host services do not establish actual multi-host acceptance. See [verification and limits](verification/2026-11-05-composition.md) and PROGRESS.md for current evidence.

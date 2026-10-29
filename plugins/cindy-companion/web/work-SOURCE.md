# Work arrangements and companion tasks

Source: makecindy/cindy commit `118767c987f518286ae10a506a54287c3dc2a560`.
The code-file inventory and original SHA-256 values are in `work-upstream-files.json`.
The existing root Cindy Apache-2.0 notice applies to these source-code components;
this inventory adds no avatars, prompts, fonts, private messages or live user data.

`BotGroupPlan`, `BotGroupElapsed`, the file icon and menu styles preserve the original
JSX, tokens, geometry and user actions. The optional handoff-file callback preserves
the chip UI while moving authority to the Paseo host. The host validates the group,
plan, step, recorded artifact and workspace before opening a file. `botGroupWorkPresentation`
is an extraction of the original pure selectors/path functions, not a second plan engine.

`work-composer.tsx` extracts the original division tag and menu item. `work-plan.tsx`
uses the original plan card inside the organizer bubble. The group adapter places
the card after its persisted request and file chips under the corresponding persisted
handoff message. The wire uses zero-based `position` and `currentStep`, as the original
production `chatServer.ts` does; the displayed step label and timing-map key add one.

`work-directory.tsx` preserves the project-folder row from `BotGroupSettingsDrawer`.
Paseo has no public native directory picker, so the row opens a bounded directory
browser on the selected host. Merely browsing does not change the setting.

The adapters use real `groups.plans.*` operations, revisions and stable operation IDs.
They keep native preparation, permission, stopping and unknown outcomes visible.
Accepted work does not mean completed work, and completed steps do not mean human
acceptance or release of a companion's responsibility. A queued note says it will be
read after the current turn. Failed mutations keep their errors across polling.

`BotCollaborationCard` and `BotGroupTaskCard` are retained original source for the
companion-task adapter. `companion-task-card.tsx` extracts the original chip, status,
duration and card JSX, with an explicit renderer projection and awaited action
callbacks in place of Electron task/PR stores. Frozen receipts stay frozen, and
unknown note delivery keeps its draft. PR chips require a real host PR catalog and
are not fabricated. The group adapter now binds it to the actual persisted task message, parent session,
owner and result receipt. A result from a later run cannot rewrite that historical card.

Tests render the actual original plan widgets and actual adapter callbacks with only
the host/UI platform boundaries substituted. They cover revision/idempotency,
double clicks, late/unmounted/wrong-host replies, file identity and directory choice.
These tests are not visual or installed-host verification; root owns that release gate.

Private task cards use `client/task-card.tsx`, a React Native translation of the same
560px card geometry and controls. The public timeline transformer can replace only
one source row. It therefore anchors cards at successfully completed, schema-checked
`cindy_memory` delegation tool calls, rather than claiming the original Cindy
whole-turn “after the introduction” placement. Failed, unrecognized and malformed
tool calls keep their native rendering. Each card independently verifies its actual
parent conversation and bot/task ownership with the backend. Original native task
results are currently selectable plain text: the public plugin SDK has no equivalent
of Cindy's rich Markdown/structured-answer renderer. Group cards retain Markdown.
The original PR chips are not populated without a verified PR catalog.

Native open-file navigation is optional and awaited. Old hosts show an explicit
upgrade message while preserving the card and its Open task action. Both DOM and
native adapters use original operation IDs after lost acknowledgements, keep
mutation errors across read refreshes, and ignore closed or replaced-host callbacks.
The organizer request status row has its own real Stop action, including when a lost
creation acknowledgement left a nonempty, read-only draft. Unknown cancellation
remains unknown until the service confirms it.

The native `TaskOwnerChip` preserves the original title-adjacent 24px pill, 20px
avatar, 200px maximum and original `bots.session` labels. A dedicated current-agent
lookup verifies the durable task child and workspace. Releasing future follow-up
responsibility does not erase creation ownership; completion is not human acceptance.
The chip uses an optional generic host agent-header slot and is absent on older
hosts rather than appearing in another agent's workspace toolbar.

When an older host cannot atomically admit an idle task send, the service preserves
the unsent queue and returns a precise host-upgrade blocker. Cards show that blocker
and expose same-task Continue/Stop recovery using the original chip style. They do
not present the unsent task as running or replay its original objective.
The task service persists a payload fingerprint for every queue/resume/edit/withdraw
operation ID. Repeating an acknowledged or uncertain operation therefore refers to
the original intent even after task state advances. The frontend preserves that ID
until a real acknowledgement; it does not infer delivery from polling alone.

Admission, stop and cleanup messages are explicit host adapters in
`shared/execution-notice.ts`, shared by the native and DOM cards. A missing safe
provider admission capability is known unsent; updating the app is not presented
as sufficient to enable it. A lost send acknowledgement stays uncertain even if
the native session later looks idle. Exact-stop recovery opens the recorded native
session and preserves Stop until the service confirms its outcome. Organizer
requests expose their recorded native session through the same Open task action.

`group-cleanup.tsx` uses the original Button and status-row styles for a new host
limitation: cleanup never silently archives a user-accessible native session.
The user opens and archives that session in Paseo, then confirms cleanup through
the service's read-only reconciliation action. Pending cleanup stays visible on
completed/failed organizer requests and deleting groups; acknowledgement alone
does not clear it or change the plan outcome.

# Personal skills in modern companion settings

This slice adapts `BotCapabilitySettings.tsx` from makecindy/cindy commit
`118767c987f518286ae10a506a54287c3dc2a560`, under the distributed upstream
Apache-2.0 code license. `skills-upstream-files.json` records the original SHA.
The unchanged source remains under `vendor/renderer`; the build alias selects
the adapted `web/adapters/bot-capability-settings.tsx`. No assets are added.

The modern page retains the original search input, toolset/MCP/skill order,
fieldset and row geometry, original Input/Button/Switch components, personal
rows before shared skills, and the disabled personal toggles. The modern
original has no personal skill click-to-edit action. The older remote generic
form is not introduced here, and the Advanced Open folder action is unchanged.

The catalog's bounded first personal page is reused. Search queries and explicit
Load more actions call the host's complete personal index through `skills.list`,
with revision-bound offset/limit continuations and total counts. Shared provider entries retain
their original local filtering. A pending/error read keeps its own owner, bot,
model/catalog generation and query identity; old callbacks and responses cannot
alter another page. Errors retry the same offset. A nonprogressing or missing
continuation is an error, never a claim that the first page is the whole library.
No filesystem paths or body content are retained in the client list. Changed
catalog revisions or duplicated slugs discard the mixed page, keep the search,
and require an explicit reload from offset zero. A legacy unversioned response
can only represent a complete library without a continuation.

Adaptations visible in the original skill section are a count and compact
secondary continuation/retry button. Provider directory errors are shown
independently and do not hide personal skills. The original personal helper
line is replaced with an accurate loading-unconfirmed statement: a persisted
enabled skill is not proof that the running native session has loaded it.
This matches the current `pending/native-loading-unverified` contract.

React component tests exercise real search/continuation callbacks, owner changes,
late replies, collapsed/unmounted views and error recovery. The full surface
graph test links the selected adapter against the existing web runtime. These
tests are not an installed-host, screenshot or narrow-viewport visual acceptance;
those remain part of the parent integration check.

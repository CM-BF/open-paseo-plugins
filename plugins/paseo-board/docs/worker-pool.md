# Board storage workers (PR implementation)

This change is under review. Local installation for user testing is authorized,
but it must not merge into main until the user explicitly approves. Existing hosts use the
user-approved compact status probes: commits update an in-memory index, and an
idle probe does not read Board files or histories. Optional host push work is
kept separate. The client must accurately report its synchronization state.

## Ownership and limits

The plugin coordinator owns the service journal, agent subscriptions, compact
Board summary index and authenticated IPC endpoint. Storage operations run in a
fixed pool of child Node processes. The default is two workers (one on a machine
reporting one available CPU); configuration permits one through four. Each child
has a 384 MiB V8 old-space limit. This is not a total resident-memory guarantee.

A stable hash assigns each Board to one worker. A worker executes one operation
at a time, preserving FIFO within a Board. Independent partitions can proceed
concurrently. Boards sharing one partition can delay one another; this is bounded
isolation, not a dedicated process per Board.

Default admission limits include the active request:

| Limit | Default |
| --- | --- |
| Pending requests per worker | 32 |
| Pending requests per Board | 8 |
| Serialized request bytes per worker | 16,000,000 |
| Startup / active operation timeout | 25 seconds |

Admission reserves capacity and copies arguments before awaiting startup or a
queue. Capacity rejection does not execute the request. Producers should retain
the same durable request for an explicit retry. This does not add an unbounded
queue in front of the existing producer journals.

The coordinator still performs IPC serialization and handles requested full
reads. Ordinary feed writes carry a bounded sample/batch into the worker and
return an ACK plus a compact commit event; they do not first transfer the full
Board into the coordinator for authorization. The worker checks the persisted
writer identity at the mutation boundary. This pool does not move browser chart
rendering, authored JavaScript or iframe painting off the browser's UI thread.

## Durable results and recovery

A commit event follows the durable storage write. Worker exit or timeout has two
different results:

- A queued operation that has not been sent fails as `worker_unavailable` and is
  known not to have executed.
- An in-flight mutation without a response fails as `outcome_unknown`. It may
  already be committed. The coordinator never automatically replays it. Existing
  event IDs and feed generation/sequence receipts make an identical explicit
  retry safe where that operation supports durable idempotency.

An exited worker triggers recovery, with at most three replacement starts in a
rolling minute and bounded backoff. Ordinary requests obey that same admission
gate. There is no idle process-health polling. On restart the worker rereads its
partition and publishes recovery events with the real canvas revision; this
repairs a lost commit notification and same-revision attention changes.

One coordinator holds the storage lease. Stale ownership is replaced only when
the previous coordinator and all recorded children are dead. A separate atomic
directory lock serializes lease acquisition so competing starters cannot both
remove and replace a stale lease. A crash inside that short acquisition phase
can leave `.store-pool-reclaim`; startup then reports `worker_busy`. It does not
guess that this second lock is stale. Manual recovery must first verify all
recorded processes are stopped. Plugin shutdown releases only its own lease and
stops its children. Parent IPC disconnect makes a child exit.

## Packaging and validation

`npm run build:worker` bundles the worker and its storage dependencies into
`server/assets/store-worker.txt`. That checked-in artifact is embedded by the
Paseo compiler, then written to a private, content-addressed `.cjs` file at
startup. Existing bytes and symlink status are checked before execution. No
runtime dependency installation or downloaded executable is needed for a worker.
Regenerate this artifact whenever its source dependencies change.

The process tests use real subprocesses and private fixture storage. They cover
FIFO, process count, admission, caller-owned argument changes, durable feed
replay, a committed result lost before IPC, unsent requests, independent
partitions, coordinator responsiveness, ownership and shutdown. Fault injection
is confined to the fixture worker source. Source checks and isolated browser
fixtures do not establish native acceptance of a new host build.

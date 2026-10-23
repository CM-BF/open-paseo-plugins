# Aide: a proactive personal agent for Paseo

Meta Muse, OpenAI Dots and Anthropic Claude Duet (all autumn 2026, all closed and cloud-hosted) share one idea: an agent that keeps working when you close the app, sends a morning brief, checks your things every few hours, and messages you only when something needs you. Aide brings that to [Paseo](https://paseo.sh), on your own computer, with any Claude or Codex model.

| | Muse / Dots / Duet | Aide |
| --- | --- | --- |
| Where it runs | Vendor cloud VM | Your Paseo daemon |
| Chat and notifications | Vendor app, WhatsApp, Slack | The Paseo app on desktop and phone (push via Paseo) |
| Morning brief | Duet | Daily at a time you pick |
| Background checks that stay quiet | Duet "every few hours", Dots read-only research | Read-only child agent on a cheaper model, every 2 h by default, with a no-op back-off |
| Self-scheduled follow-ups | Dots | `remind` (message at a time) or `check` (look, speak only if needed), with repeats |
| Approval for outward actions | All four | Chat's own approval mode + explicit rule; check-ins can't write at all |
| Log of past and planned actions | Muse | Activity and Planned on the Aide screen |
| Memory | Account memory | `MEMORY.md` in the assistant's folder |
| Connectors | 1,000s of vendor apps | Whatever your agents already reach: Claude connectors, MCP servers, `gh`, files, web |

Prior art this borrows from: [hermes-muse](https://github.com/xiaohei-info/hermes-muse) (MIT; Muse-style proactive companion for Hermes: background watch delivered into the bot chat, done / later / never feedback), [HeartBeat 2.0](https://github.com/electricsheephq/heartbeat2) (Apache-2.0; structured notify-or-silent verdicts instead of sentinel strings, no-op governor, quiet hours, caps, unanswered mute), OpenClaw's heartbeat, Hermes `/heartbeat` and `/loop`, and [paseo-bots](https://github.com/oliexe/paseo-bots) for the loopback MCP relay. Aide does not reimplement paseo-bots' roster of bots; the two can run side by side.

## Install

```bash
npm ci
paseo plugin install /absolute/path/to/plugins/paseo-aide --id paseo-aide
# or from Git, pinned: paseo plugin install <git-url> --path plugins/paseo-aide --ref <commit>
```

Requires Paseo 0.12 with plugins enabled. Open **Aide** in the sidebar, pick a folder and models (defaults: chat `claude/claude-sonnet-5-5` in Auto mode, check-ins `claude/claude-haiku-4-5`), and write what it should watch.

## How it works

```
                    tick every 30 s (active hours, caps, pause)
                                   │
     ┌──────────── due? ───────────┼──────────────────┬─────────────────────┐
  check-in                      follow-up           brief             snooze ended
     │                     remind │ check │            │                     │
 child agent (parent = chat,      │       └─ child ────┤                     │
 read-only, cheap model)          │                    │                     │
     │ aide_checkin_report        │                    │                     │
     ▼                            ▼                    ▼                     ▼
 merge into alerts (keys, done / snoozed / muted)  ─►  outbox ─► note to the chat when idle
     │ quiet → nothing sent, interval stretches       (clears the unread mark first)
     ▼                                                       │
 Activity log                                     chat writes one message → Paseo push
```

- The chat is an ordinary Paseo agent created by the plugin with a system prompt and the plugin's MCP tools (`aide_followup_create/list/cancel`, `aide_alerts`, `aide_alert_update`, `aide_status`, `aide_schedule_update`, `aide_paseo_waiting`).
- A check-in is a child agent (`parent` = the chat). Paseo 0.12 raises no attention and sends no push for agents with a parent, which is what makes quiet checks silent. It reports through `aide_checkin_report`; a JSON object in its last message is the fallback. It is archived when done.
- Every permission prompt a check-in raises is answered by `server/policy.ts`: reads, web search, MCP tools whose name starts with a read verb, and read-only `git`/`gh`/`paseo` commands are allowed; everything else is refused with a reason. Command substitution, chaining, redirection and environment prefixes are refused outright.
- The plugin's notes to the chat start with `<!-- aide:{json} -->`. A timeline transformer renders them as a compact card with Done / Later / Don't remind me; the chat's reply is what reaches the phone. Paseo sends no push while an agent is still unread, so the outbox clears the mark first (through a local daemon connection, as the `paseo` CLI connects).
- Scheduled work needs a Paseo connection outside any hook: the plugin uses the one hooks and RPCs hand it, and otherwise opens a local one from `paseo.pid` and the local credential.
- MCP runs on a loopback HTTP port that is kept across reloads; each agent gets its own HMAC token, and a check-in's token stops working when its run ends.

State lives in `~/.paseo/paseo-aide/` (`state.json`, `activity.jsonl`) and survives plugin updates and removal.

## Develop

```bash
npm run typecheck   # server + a client-only pass without Node types
npm test            # vitest: time zones and DST, the follow-up time language, schedule, policy, alerts, prompts, and the service against a fake Paseo
paseo plugin reload paseo-aide
```

Layout: `shared/` (time, schedule, `when` parser, types, RPC contracts, note format), `server/` (service, runner, outbox, MCP relay and tools, policy, prompts, store, access), `client/` (Aide screen, setup, settings, chat card, sidebar). Progress, decisions and verification records are in [PROGRESS.md](PROGRESS.md); screenshots in `docs/verification/`.

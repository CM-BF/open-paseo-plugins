Aide is an always-on personal agent for Paseo, in the spirit of Meta Muse, OpenAI Dots and Claude Duet, running on your own computer. You chat with it like any Paseo agent, on desktop or phone. On its own it sends a morning brief, looks around in the background every few hours and speaks up only when something needs you, and keeps the follow-ups it promises.

## How it works

- **The chat.** Setup creates one ordinary Paseo agent in a folder you choose. The folder holds `MEMORY.md` (what it knows about you, which it keeps up to date) and `WATCHLIST.md` (what the background checks look at). You and the assistant can both edit them.
- **Background check-ins.** Every two hours by default, inside your active hours, a separate read-only agent on a cheaper model reads the watch list and checks what it can reach: files, `gh` and `git`, connected mail or calendar tools, the web, and Paseo agents waiting on you. It runs as a child of the chat, so Paseo shows no unread badge and sends no notification for it. When it finds something new, the chat writes you one short message and your phone is notified. When nothing changed, nothing happens. After several quiet checks the interval stretches out by itself.
- **Morning brief.** At the time you pick, the chat writes a short brief: today's events if it has calendar or mail tools, what needs you, and what is planned.
- **Follow-ups.** When it promises to come back to something, it schedules a reminder (a message at that time) or a background check (it looks and speaks up only if needed). Repeats such as "weekdays 8:30" are supported.
- **Needs you.** Findings wait in the Aide screen and on a card in the chat with Done, Later and Don't remind me. Later brings it back after the snooze; Don't remind me stops it for good. You can also just tell the chat.

## The Aide screen

The sidebar entry shows the number of open alerts. The screen lists what needs you, Paseo agents waiting on an approval or after an error, what is planned (next check-in, brief, follow-ups), everything Aide did on its own, and editors for the watch list and memory. Check now, Brief me and Pause are there too. Settings → Plugins → Aide sets the interval, daily limits, active hours, brief time, time zone, language and the check-in model. You can also ask the chat, for example "check every hour" or "pause until tomorrow morning".

## Permissions and limits

- The chat uses the approval mode you choose (Auto mode by default). It is told to read, draft and prepare freely, and to show you exactly what it will do and get a yes before anything that sends, posts, pays, books, signs, deletes or changes accounts. Paseo's own approval prompts still apply.
- Background checks cannot write. Aide answers their permission prompts itself: reading files, web search, tools named like get, list or search, and read-only `git`, `gh` and `paseo` commands are allowed; edits, sends, questions, chained commands, redirections and other programs are refused. Web pages are fetched only from plain URLs without query strings.
- Ordinary findings are held back outside active hours, after the daily message limit, and while three proactive messages go unanswered; urgent ones and checks you asked for are not. Held items stay in Needs you.
- Check-ins use model time like any agent turn: about one short run every two hours with the defaults. Agent creation hooks of other plugins also apply to check-ins.
- Works with Claude and Codex chats and check-ins. Needs Paseo 0.12. A phone notification needs the Paseo app with notifications on, and is not sent while you are looking at that chat. Aide keeps its state in `~/.paseo/paseo-aide`, separate from the plugin, and never sends data anywhere other than through the agents and tools you already use.

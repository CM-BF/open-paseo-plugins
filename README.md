# open-paseo-plugins

Paseo plugins, one directory each under `plugins/`.

| Plugin | What it does |
| --- | --- |
| [paseo-board](plugins/paseo-board) | Persistent, fully interactive canvases authored by agents, with live updates, contextual questions and forks, and records of the agent's default decisions. |
| [paseo-dynamic-workflow](plugins/paseo-dynamic-workflow) | Claude Code style dynamic workflows for any Paseo agent: a script fans out, verifies and synthesizes across Paseo agents of any provider. |
| [learning-loop](plugins/learning-loop) | Hermes-style learning loop for every Paseo agent: shared bounded memory and agent-written skills, revision-checked proposals, repository-scoped session recall, and a background review with a daily budget. |
| [paseo-aide](plugins/paseo-aide) | A proactive personal agent in the spirit of Meta Muse, OpenAI Dots and Claude Duet: a morning brief, quiet read-only background check-ins that speak up only when something needs you, follow-ups it schedules itself, and a Needs you inbox with a log of past and planned work. |
| [paseo-rate-fallback](plugins/paseo-rate-fallback) | Fork rate-limited Claude tasks to GPT-6.1 Ultra and return progress after reset; restore Codex model settings after fallback. |
| [paseo-gemini-voice](plugins/paseo-gemini-voice) | Chinese for Paseo dictation and voice mode: Gemini recognizes mixed Chinese and English speech, and voice mode replies are read aloud by Gemini TTS or macOS speech. |

Development and testing rules for this repository are in [AGENTS.md](AGENTS.md).

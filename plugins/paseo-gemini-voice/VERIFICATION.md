# Verification

Verified on 2026-10-23 against the local Paseo 0.12.0 daemon (`srv_BSheQn5lzdEE`, home `~/.paseo`, listen `127.0.0.1:6767`).

## Automated

- `npm run typecheck`: passed (run in the scratch copy `/tmp/paseo-plugin-verify/paseo-gemini-voice`; dev dependencies are never installed in the plugin directory).
- `npm test`: 80 tests passed across eight files. They cover multipart parsing, WAV silence gating including the Apple FLLR chunk, Interactions API request bodies and error mapping, fallback on 404/timeout but not on auth errors, the proxy driven by `openai@6.44.0` (the daemon's SDK version) with `fs.createReadStream` exactly like Paseo's `OpenAISTT`, no SDK retries on errors, port-busy retry, lossless apply/revert of `config.json` (including another OpenAI endpoint, port changes, edits made after the apply, and a lost apply record), and the status transitions not applied → pending restart → active. Speech output tests cover markdown and `<...>` cleanup, Chinese and English chunking, L16 and WAV responses, the `speech_config` → `structured_speech_config` retry, parallel synthesis that keeps chunk order when replies finish out of order, the macOS fallback (with a stand-in `say`), the real macOS `say` producing 24 kHz audio, the proxy's `/v1/audio/speech` driven by `openai@6.44.0` `audio.speech.create` with `response_format: "pcm"`, and the 11-key apply/revert including a custom `providers.local.modelsDir`, an upgrade from a dictation-only apply and a lost apply record.
- Request bodies were checked field by field against Google's published `interactions.openapi.json` (`transcription_config`, inline `audio` content with `audio/wav`, `store`, `system_instruction`, `response_format`, `Api-Revision: 2026-05-20`).
- Hermes check (`tools/hermes-compat`): `static clean; hermes OK`.

## Live, main daemon

- Installed from the directory source; `paseo plugin ls` reports `running` with no error. `GET 127.0.0.1:6791/healthz` answers; a wrong bearer token gets 401. `config.json` gained only the `plugins` entry written by the install.
- `server/live-smoke.ts status`: the `voice.status` RPC answered through the daemon with `not-applied`, the proxy listening, and the worker start time `2026-10-22T07:24:30Z`.
- Settings RPCs: saving `port: 6792` moved the proxy to 6792, saving 6791 moved it back, and 6792 closed.
- Baseline with the current local Parakeet STT (`server/live-smoke.ts baseline`): the sample "用 TypeScript 写一个 Paseo 插件，然后 commit 到 main branch。" came back as "Yung TypeScript See the Passio Tadian, Yang Ho commit the main branch."
- UI at `app.paseo.sh/settings/hosts/srv_BSheQn5lzdEE/plugins/paseo-gemini-voice/settings`: rendered with no page or console errors at 1500×1100 light and 390×844 dark and light. The vocabulary editor spans the card; "写入配置" stays disabled until a key is saved.

## Live, voice mode

- The installed plugin's `voice.tts.preview` RPC, with no Gemini key saved, fell back to macOS `Tingting` and returned a 7.0 s, 24 kHz, 16-bit mono WAV in 0.8 s. `voice.tts.mac-voices` listed the installed Chinese voices.
- UI: the new "语音对话的朗读" section rendered at 390×844 light with no page or console errors.

## Live, isolated daemon

`server/live-smoke.ts e2e --fake` starts `paseo daemon run --home <temp>` on a free port with dictation and voice mode pointed at a standalone proxy, which talks to a fake Gemini API. It streams the bundled sample as 100 ms `audio/pcm;rate=16000;bits=16` chunks, like the app's `DictationStreamSender`.

- The isolated config is a minimal base plus the plugin's own `applySpeechConfig`, so the real daemon's strict schema accepted exactly the 11 keys the plugin writes.
- `server_info.capabilities.voice` reported dictation and voice mode available (empty `reason`). Control run with `providers.local.modelsDir` removed: voice mode reported "Realtime voice is unavailable: turn-detection service is not ready."
- Speech through the written `providers.openai.tts` endpoint returned one second of 24 kHz PCM from the fake Gemini TTS.
- The fake Gemini API received one transcription request with the key header, `model: gemini-3.5-transcribe`, `store: false` and a 24 kHz `audio/wav` clip (Paseo resamples dictation for OpenAI STT), and one speech request for `gemini-3.8-flash-lite-tts`. The dictation final text was the fake transcript.
- Cleanup: the isolated daemon exited, its temp home was deleted, and the main daemon kept pid 56967 / worker 56969.

## Live, main daemon with the speech config applied

- The config was applied from the settings page at 2026-10-23T21:13:34Z and the daemon worker restarted at 23:24:09Z. `voice.status` reports `active`; `server_info.capabilities.voice` reports dictation and voice mode available (empty `reason`).
- The user confirmed dictation works. The plugin counted 4 dictation requests after the restart, all through `gemini-3.5-transcribe` with no fallback and no failures, about 23 s of audio in total; a 7.2 s clip took 2.8 s. Transcripts are not recorded here.
- Real Gemini TTS through the installed plugin's speech preview: `gemini-3.8-flash-lite-tts`, voice Kore, no macOS fallback; 7.2 s of 24 kHz audio in 2.4 s. After a plugin reload, which resets the remembered field name, a second preview (6.2 s in 2.0 s) succeeded with no `speech_config` rejection in the plugin log, so the API accepts `generation_config.speech_config`.
- A fresh `git archive` export installed with `npm ci` from the committed lockfile and passed typecheck and all 80 tests.
- Screenshots, kept outside the repository because they show the host name and the key's first and last four characters: `~/.paseo/verification/paseo-gemini-voice/2026-10-23-settings-wide-light-{1..3}.png` (1440×900) and `2026-10-23-settings-compact-dark-{1..6}.png` (420×860). No page or console errors.

## Not verified yet

- A full voice conversation with an agent on the phone (spoken input, the agent's `speak` call, playback). Voice mode had not been used on the main daemon yet; the speech endpoint was exercised through the preview, and the isolated run checks readiness and each endpoint separately without starting an agent.
- The isolated daemon runs were a supplement: writing the speech config needs a daemon restart, so real-daemon checks waited until the user restarted it.

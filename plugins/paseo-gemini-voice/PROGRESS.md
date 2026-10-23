# paseo-gemini-voice（Gemini 中文语音）：进度记录

## 目标与设计

Paseo 0.12 的听写只有两种语音识别：本地 Parakeet（v2 只支持英语，v3 只支持 25 种欧洲语言，都不支持中文）和 OpenAI 兼容接口。插件在 daemon 子进程里开一个只监听 127.0.0.1 的 OpenAI 兼容 `/v1/audio/transcriptions`，把 Paseo 发来的 24 kHz WAV 交给 Gemini Interactions API 的 `gemini-3.5-transcribe`（自动识别语言、支持句内中英混说和专有词），失败时改用 `gemini-3.5-flash-lite` 加转写提示词和 JSON 输出。

- Paseo 没有给插件的语音扩展点，`paseo.config.patch` 也改不了 `features` 和 `providers.openai`，所以插件直接改 `config.json` 里四个键：`features.dictation.stt.provider/model`、`providers.openai.stt.apiKey/baseUrl`。写前备份到 `plugin-data/paseo-gemini-voice/backups/`，并记录原值，恢复时逐键还原。
- 语音配置只在 daemon worker 启动时读取（`daemon-worker.ts` → `loadConfig`），`paseo reload` 的可热更新列表里没有这些键。写入后要重启一次 daemon。设置页的「重启 Daemon」只重启 worker，不重启 supervisor，所以 `paseo.pid` 的 `startedAt` 不变；插件改用父进程（worker）的 `ps -o lstart` 判断配置是否已生效，或者以收到 daemon 带正确令牌的请求为准。
- 本地转发用随机令牌鉴权（存在 0600 的 `credentials.json`，同时写进 config.json）。Gemini key 也存在这个文件里，不进设置文档；设置文档对该主机的所有客户端可读。
- 错误回给 daemon 时带 `x-should-retry: false`，避免 daemon 的 OpenAI SDK 对 429/5xx 自动重试两次拖住听写。
- 语音对话也走本地转发：识别复用 `/v1/audio/transcriptions`；朗读新增 `/v1/audio/speech`，返回 Paseo 的 OpenAI TTS 期望的 24 kHz 16 位单声道 PCM。Gemini 朗读用 Interactions API 的 `gemini-3.8-flash-lite-tts`，`response_format` 要 `audio/l16`、`sample_rate: 24000`。教程的 REST 示例用 `generation_config.speech_config`，OpenAPI 规范写的是 `structured_speech_config`，插件先发前者，被拒时换后者并记住。
- Paseo 的 `tts-manager` 只按 `. ! ?` 加空格分句，中文回复会成为最长 260 字的一段，而且要整段音频收齐才发给客户端播放。插件把每段再按中文句末和逗号切成约 90 字的小块，最多 3 块并行合成后按顺序拼接，缩短第一句出声前的等待。
- macOS `say -v <音色> --file-format=WAVE --data-format=LEI16@24000` 直接产出同样格式，预热后一句约 0.7 秒。它既是可选的离线引擎，也是 Gemini 朗读失败时的自动兜底。
- 写入语音对话配置时必须同时写 `providers.local.modelsDir`：听写、语音识别和朗读都不用本地模型时，daemon 不创建本地语音 worker，语音对话的 VAD 跟着消失，能力里报告 `turn-detection service is not ready`。隔离 daemon 的对照实验验证了这一点。插件写入的是 Paseo 的默认目录，已有自定义目录时保持不变；恢复时只删除等于默认目录的值。
- 设置页的「可用」以 `server_info.capabilities.voice.*.reason` 为空为准；`enabled` 只反映配置开关。
- `requirements.paseo` 是 `>=0.12.0`。0.13.0-beta.2 的语音配置结构、OpenAI STT 提供方和配置解析与 0.12.0 完全相同，插件用到的接口都还在；不设上限，避免升级 Paseo 后插件被停用而听写配置仍指向它。

## 子任务状态

- [x] 本地转发、multipart 解析、WAV 静音判断（峰值低于 250 或短于 0.25 秒不发送）。
- [x] Gemini Interactions API 调用：transcribe 模型、通用模型提示词、错误分类、超时与备用模型。
- [x] config.json 写入与无损恢复，环境变量覆盖检测，worker 启动时间判断。
- [x] 设置页（状态、key、示例音频测试、写入/恢复、模型、整理方式、语言、专有词、端口）、⌘K 命令、`/gemini-voice` 斜杠命令。
- [x] 语音对话：Gemini 识别、Gemini/macOS 朗读、自动兜底、试听、写入 11 个配置键（含 `providers.local.modelsDir`）及无损恢复。
- [x] 80 项单测；Hermes 包检查；已安装到主 daemon 并运行。
- [x] 隔离 daemon 端到端（假 Gemini）：配置由插件自己的写入逻辑生成并被 daemon 的严格校验接受；听写和语音对话的能力都为可用；App 方式推 PCM 的听写返回文字；`providers.openai.tts` 上的朗读返回 PCM。去掉 `modelsDir` 的对照组语音对话不可用。
- [x] 主 daemon 上的试听：没有 key 时自动改用 macOS Tingting，0.8 秒合成 7 秒 24 kHz 语音。
- [x] 真实 Web UI 截图：桌面浅色、手机尺寸深色和浅色，无页面错误。
- [x] 主 daemon 写入配置并重启：配置写入 2026-10-23T21:13:34Z，worker 23:24:09Z 重启后状态为已生效，听写和语音对话的能力都可用。
- [x] 真实 Gemini 识别：用户确认可以工作；重启后 4 次听写全部经 `gemini-3.5-transcribe` 完成，0 次失败，未用备用模型。
- [x] 真实 Gemini 朗读：两次试听都由 `gemini-3.8-flash-lite-tts`（Kore）完成，未退回 macOS；重载后第一次请求就被接受，说明 API 接受 `generation_config.speech_config`。
- [ ] 手机上完整的语音对话（说话 → Agent 调用 speak → 播放）：用户还没在语音对话模式里用过，尚未验证。

## 验证记录

2026-10-23，Paseo 0.12.0，主 daemon `srv_BSheQn5lzdEE`（home `~/.paseo`，listen `127.0.0.1:6767`），插件为本机目录源 `~/Projects/Paseo/plugins/paseo-gemini-voice`。场景、数据和未验证项见 [VERIFICATION.md](VERIFICATION.md)。

- 类型检查、80 项单测、Hermes 检查通过；从 git 导出的干净副本用 `npm ci` 安装后同样通过。
- 改用 Gemini 前的对照：示例句「用 TypeScript 写一个 Paseo 插件，然后 commit 到 main branch。」被本地 Parakeet 识别成 "Yung TypeScript See the Passio Tadian, Yang Ho commit the main branch."
- 隔离 daemon（`paseo daemon run --home <临时目录>`，假 Gemini）补充验证了配置结构、语音对话可用性和去掉 `modelsDir` 的对照组；写入配置要重启 daemon，真实验证随后在主 daemon 上由用户重启后完成。
- 截图（只存本机，含主机名和 key 前后四位，不进仓库）：`~/.paseo/verification/paseo-gemini-voice/2026-10-23-settings-wide-light-{1..3}.png`（1440×900）、`2026-10-23-settings-compact-dark-{1..6}.png`（420×860），页面连本机 daemon，状态为「已改用 Gemini」，无页面错误。

## 安装与发布状态

主 daemon 使用本机目录源 `~/Projects/Paseo/plugins/paseo-gemini-voice`，插件 ID `paseo-gemini-voice`，状态 running。语音配置已写入主 daemon 的 `config.json`，写入前的备份在 `~/.paseo/plugin-data/paseo-gemini-voice/backups/`；在设置页点「恢复」并重启 Daemon 即回到 Paseo 自带的本地模型。

发布目标为 `CM-BF/open-paseo-plugins` 的 `main`，目录 `plugins/paseo-gemini-voice/`。本机 `Projects/Paseo` 与远端历史不同；发布时在远端 main 上加入本插件目录和 README 条目，保留远端已有提交。发布只移动 Git 内容，不替换 daemon 的安装源。

## 已知限制

- 听写段与段之间的空格来自 daemon 的 `join(" ")`，插件无法去掉。
- 语音对话的朗读是整段收齐才播放，这是 Paseo `tts-manager` 的行为；插件只能通过并行合成缩短等待。

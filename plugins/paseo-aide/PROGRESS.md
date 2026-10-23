# paseo-aide：进度记录

## 目标

给 Paseo 做一个类似 Meta Muse、OpenAI Dots、Anthropic Claude Duet 的“常驻个人助手”插件 Aide：

- 一个固定的助手聊天（普通的 Paseo agent），手机 Paseo app 里就能聊；
- **早报**：每天定时写一份简报推到手机；
- **后台检查**：按间隔在后台看用户让它盯的东西（WATCHLIST.md、Paseo 里等着用户的 agent、可选的邮件/日历连接器、gh 等），**没事不出声**，有事才在聊天里说并推送；
- **自排跟进**：助手可以给自己排“到点提醒”或“到点后台看一眼”，重复规则可选；
- **需要你**收件箱：每条提醒可标“已处理 / 稍后 / 别再提”，后台检查据此去重；
- **活动记录**：已做的和计划要做的（下一次检查、早报、跟进）都能看到；
- 只读、起草、准备可以自己做；发送、付款、删除、签署等对外动作先问用户（Duet 的规则）。

## 调研结论（2026-10-23）

| 产品 | 是否开源 | 要点 |
| --- | --- | --- |
| Meta Muse（2026-09-08） | 否 | 每人一台云端 VM；WhatsApp/app；循环任务直到取消；独立的审批 agent 审每个连接器动作；活动记录显示过去和计划中的动作 |
| OpenAI Dots（2026-09-29） | 否 | 每个 dot 一台 Linux + Chrome；自排后续跟进；后台只读的 proactive research；可委派 Codex；Slack/Teams |
| Anthropic Claude Duet（2026-10-21） | 否 | 云端 VM + 浏览器；早报；每隔几小时检查连接的应用，需要时才找你；发送/付款/签署/删除前要批准 |
| Grok Bot | 否 | 多个角色 bot，团队群聊 |

开源的同类：

- Paseo 注册表：`oliexe/paseo-bots`（MIT，本机已安装）是 Grok Bot / Hermes Bots 式的多 bot 名册（指令、模型、MEMORY.md、cron/webhook routine、团队、Composio 连接器）。**没有**主动检查后静默、早报、自排跟进、需要你收件箱、计划中动作的展示。`daaaaave/telegram`（Telegram 桥）、`panrafal/agent-heartbeats`（原生 heartbeat 的管理 UI）、`romejiang/watch-notify`（Apple Watch 推送）、`koinzhang/inbox`（收藏 agent 和笔记）都只覆盖其中一小块。
- Hermes 社区：`xiaohei-info/hermes-muse`（MIT，直接以 Meta Muse 为蓝本：6 个固定 cron、主动巡查、记忆维护、目标跟进、“已处理/晚点/别再提”反馈、后台结果投回 Bot Chat 再由主会话说一轮）；`electricsheephq/heartbeat2`（Apache-2.0：agent 用工具给出结构化判定 notify/静默而不是打哨兵字符串；no-op governor 退避；安静时段、每日上限、未回复静音；错过的触发合并成一次）。Hermes 自带 `/heartbeat`、`/loop`、cron、Bot Mode。
- pi 社区：`@davecodes/pi-routines`（定时/事件 routine、早报）、`pi-schedule-prompt`、`@patimweb/pi-cron`、`@marcfargas/pi-heartbeat`、多个 Telegram 桥。
- OpenClaw（MIT）：heartbeat（默认 30 分钟、HEARTBEAT.md、`NO_REPLY`），现已并入通用 automation jobs（activeHours、delivery.target）。

结论：Muse/Dots/Duet 都不开源；最接近的开源实现是 hermes-muse + heartbeat2（Hermes 插件，Python），Paseo 上还没有。本插件把它们的做法搬到 Paseo，不重做 paseo-bots 已有的东西。

## 设计决定

| 决定 | 原因 |
| --- | --- |
| 助手是一个普通 Paseo agent（默认 `claude/claude-sonnet-5-5`，`auto` 模式），工作目录是用户选的文件夹（默认 `~/Aide`），里面放 `MEMORY.md`、`WATCHLIST.md` | 手机 app、推送、权限审批、聊天全部复用 Paseo 原生能力；记忆和关注列表是用户能直接看、能改的文件 |
| 后台检查跑在**子 agent**（`parent` = 助手）里，用便宜模型（默认 `claude/claude-haiku-4-5`），跑完 archive | Paseo 0.12 对“有 parent 的 agent”不发 attention 和手机推送（`isDelegatedAgent`），所以没事时真正静默；主会话上下文不被巡查刷屏；成本低 |
| 子 agent 用 MCP 工具 `aide_checkin_report` 交结构化结果（notify、summary、items[key,title,detail,urgency]），拿不到时再从最后一条消息里解析 JSON | heartbeat2 的经验：不靠模型打哨兵字符串 |
| 需要告诉用户时，插件往助手聊天发一条带 `<!-- aide:{json} -->` 头的消息，助手据此写一条简短消息；这一轮结束触发 Paseo 原生推送 | 推送正文就是助手写的话；用户可以直接在同一个聊天里回复；hermes-muse 也是“后台结果投回 Bot Chat 再说一轮” |
| 子 agent 的所有权限请求由插件按只读策略自动答复（`server/policy.ts`）：读文件、WebSearch、名字是 get/list/search… 的 MCP 工具、只读的 git/gh/paseo 命令放行；写、发送、提问、计划、命令替换、链式命令、重定向一律拒绝并说明原因；WebFetch 只放行不带 query 的 http(s) 地址 | 后台没人能回答权限请求；拒绝而不是挂起，避免卡到超时；读不可信邮件时降低外泄风险 |
| 主助手的权限照常走 Paseo 原生审批（会推送到手机）；系统提示要求对外动作先在聊天里得到明确同意 | Duet 的规则；不重做 approval-guard（上次已确认原生 Auto mode 覆盖了） |
| 调度：活跃时段内按间隔检查；连续 3 次没事就把间隔拉长（1.5×、2×、3×，最长 8 小时），用户说话或有提醒时复位；每日检查上限、每日主动消息上限、未回复上限（默认 3 条未回就先压着，急事除外）；错过的触发合并成一次；早报 4 小时宽限 | heartbeat2 的 governor、caps、unanswered mute；Duet 的“每隔几小时” |
| 跟进：`remind` 到点在聊天里提醒（不受活跃时段限制），`check` 到点走一次后台检查；重复最短 30 分钟 | hermes-muse 也限制重复 watch ≥ 30 分钟 |
| 配置存在插件状态里（`~/.paseo/paseo-aide/state.json`），UI 和助手的 MCP 工具都能改（例如“以后每小时看一次”“暂停到明早”） | 0.12 的 server 端 settings handle 只能读不能写，助手无法通过它改设置 |
| MCP 走本机 HTTP（127.0.0.1，固定端口持久化，每个 agent 一个 HMAC token），和 paseo-bots 同样做法 | 比 stdio shim 简单；check-in 的 token 只在运行期间有效 |
| 定时任务需要 Paseo 连接：优先用钩子/RPC 拿到的插件连接；还没拿到时，按 `paseo` CLI 的方式（`paseo.pid` + `local-credential`）开一条本机连接 | 插件 SDK 只在钩子和 RPC 里给连接；daemon 夜里重启后没有事件，早报会被拖到下一个无关事件（Flowly 也用同样的本机连接） |

## 子任务

- [x] 调研 Muse/Dots/Duet、Paseo 注册表、Hermes 插件目录、pi 包、OpenClaw；读 Paseo 0.12 源码确认推送和 delegated agent 的行为
- [x] 共享层：时区工具（含夏令时）、时间表达式（in 2h / tomorrow 9am / weekdays 8:30 …）、调度判定
- [x] 只读权限策略（`server/policy.ts`）
- [x] 状态存储、活动日志、本机 Paseo 连接（`server/store.ts`、`server/access.ts`）
- [x] MCP HTTP relay 和工具，助手 / 后台检查两种角色（`server/mcp.ts`、`server/tools.ts`）
- [x] 后台检查执行器、投递队列、早报、跟进、提醒合并与去重、贪睡唤醒（`server/runner.ts`、`server/outbox.ts`、`server/alerts.ts`、`server/service.ts`）
- [x] 客户端：Aide 主屏（需要你 / Paseo 里等你的 / 计划 / 活动 / 关注列表和记忆编辑）、设置向导、设置页、聊天里的更新卡片、侧栏角标、⌘K
- [x] 单测 98 个（`npm test`）；`npm run typecheck` 含一遍不带 Node 类型的客户端检查
- [x] OVERVIEW.md、README
- [x] 装到主 daemon，用新建的测试助手在 Web UI 里走真实流程并截图（见验证记录）
- [x] 清理测试 fixture
- [x] 安装源换成钉住提交的 Git 源（见交付状态）

## 验证记录

环境：主 daemon `srv_BSheQn5lzdEE`，Paseo 0.12.0，home `~/.paseo`，listen 127.0.0.1:6767。测试期间插件以目录源安装（`…/muse-dot-duet-paseo-680d/open-paseo-plugins/plugins/paseo-aide`，分支 `sw/paseo-aide`），每次改动 `paseo plugin reload`。Fixture：目录 `~/plugin-test-2026-10-23-aide`（项目 `prj_448078e0d14c6a36`、workspace `wks_7fc5487e6451ad08`），测试助手 `f065e256`（名字 Aide test，`claude/claude-haiku-4-5`，Auto mode，语言 中文），后台检查也用 Haiku 4.5。截图用本机 headless Chrome（`scripts/cdp.mjs`）打开 `https://app.paseo.sh`，URL 里的 server ID 与 daemon 一致；桌面截图裁掉了左侧栏（里面有与本次无关的会话标题），窄屏截图宽 500（Chrome 最小窗口宽度）。

| 日期 | commit | 场景 | 结果 | 截图 |
| --- | --- | --- | --- | --- |
| 2026-10-23 | cb3679b | 侧栏 Aide → 设置向导 | 列出本机 Claude/Codex/OpenCode 模型和 Claude 权限模式；默认 Sonnet 5.5 / Auto mode / Haiku 4.5 | `docs/verification/2026-10-23-setup-desktop.png` |
| 2026-10-23 | cb3679b | 填名字、中文、fixture 目录、Haiku，提交 | 建出项目、workspace 和助手（系统提示、aide MCP、预批准工具都在）；欢迎提示渲染成 Setup 卡片；助手用中文自我介绍。建 agent 用了约 25 秒（本机其他插件的 agent.create 钩子） | `…-welcome-chat-desktop.png` |
| 2026-10-23 | cb3679b | Check now | 失败：另一个插件 next-workspace 的 before agent.create 钩子超时（30 秒）。据此加了重试，见下一行 | 活动记录 |
| 2026-10-23 | e8a54c7 | 在 `inbox/urgent.txt` 写牙医改约，Check now | 子 agent（Haiku，default 模式，带 `paseo.parent-agent-id`）读文件、用 `aide_checkin_report` 报 1 条 high；子 agent `requiresAttention: false`；提醒投递，助手写出中文提醒；卡片带 Done / Later / Don't remind me；侧栏角标 1 | `…-checkin-alert-chat-desktop.png` |
| 2026-10-23 | e8a54c7 → c4e3ae3 | 推送 | 发现：欢迎消息一直未读，所以提醒那一轮没有新的 attention（Paseo 对已在 attention 的 agent 不再推送）。修复后复测：投递前清掉未读标记，助手 `attentionTimestamp` 从 17:53:51 变为 18:00:31。手机推送本身没有观察到：headless 浏览器算在场客户端，Paseo 改发应用内通知（daemon 日志 18:00 无 push） | 无 |
| 2026-10-23 | c4e3ae3 | 聊天卡片上点 Done | 提醒变 done，卡片按钮换成 Done | 无 |
| 2026-10-23 | c4e3ae3 | Aide 主屏（桌面） | 需要你、Paseo 里等你的（已完成的折叠成一行）、计划、活动都正确 | `…-dashboard-desktop.png` |
| 2026-10-23 | fd68a90 | Aide 主屏（窄屏） | 发现两列堆叠时中间有大块空白，修复后正常 | `…-dashboard-compact.png` |
| 2026-10-23 | 1aa8696 | 在聊天里说“牙医那条已处理，5 分钟后提醒我喝水” | 助手调 `aide_alert_update` 和 `aide_followup_create`，回复 11:06；中间插件 reload 过一次；11:06:59 提醒投递，Reminder 卡片 + “时间到了，喝杯水吧 💧” | `…-followup-reminder-chat-desktop.png` |
| 2026-10-23 | fd68a90 | 内容没变时 Check now | outcome quiet，聊天里没有任何新消息，助手 attention 时间戳不变 | 活动记录 |
| 2026-10-23 | fd68a90 | Brief me | Brief 卡片 + 中文早报（窄屏） | `…-brief-chat-compact.png` |
| 2026-10-23 | fd68a90 | 设置页改每日上限 6、早报 08:45，保存 | 生效，刷新后仍在；名字和暂停状态没被覆盖 | `…-settings-desktop.png` |
| 2026-10-23 | fd68a90 | 主屏 Pause / Resume | 状态 Paused，计划区提示提醒照常；Resume 后恢复 | `…-dashboard-paused-desktop.png` |
| 2026-10-23 | fd68a90 | 聊天里说“以后每3小时检查一次，早报改到9点” | 助手调 `aide_schedule_update`，配置变为 180 分钟、09:00 | 活动记录 |
| 2026-10-23 | fd68a90 | 聊天里说“2分钟后在后台看一下 urgent.txt，有新消息再告诉我” | 助手排了 check 模式跟进；到点子 agent 发现新增的一行，提醒投递：“牙医提醒：下午 5:15 的约诊要带保险卡。” | `…-followup-check-chat-desktop.png` |
| 2026-10-23 | 9bb964b | 清理时 archive 测试 workspace | 插件经钩子记为“Stopped: the chat was archived”；主屏显示 Set up again | `…-detached-setup-again-desktop.png` |

没有验证到的：

- 手机上真正收到推送（上面说明了原因）；iOS / Android app 里的渲染（只看了 Web 的窄屏布局）。
- 按计时自动触发的后台检查和早报：调度逻辑有单测；真实 daemon 上同一个 tick 循环触发了提醒和 check 跟进，但没有等到 2 小时一次的自动检查和第二天的早报。
- Codex / OpenCode 作为聊天或后台检查模型；Claude 连接器（本机 Gmail、Calendar 未授权）；后台检查里跑 `gh` 命令（只读策略只有单测）。
- 没有任何钩子事件时的本机连接兜底（这台 daemon 上一直有钩子连接）；同一套 `connectLocal` 在清未读标记时真实跑通过。
- 贪睡到期再提醒、跨天计数、夏令时：只有单测。

清理：测试 workspace `wks_7fc5487e6451ad08` 已 archive（助手 `f065e256` 和 4 个检查子 agent 都已 archive），项目 `prj_448078e0d14c6a36` 已删除（`paseo project ls` 里没有了），fixture 目录、测试用的插件状态、headless Chrome 和它的 profile、/tmp 脚本都已删除。

## 交付状态（2026-10-23）

见 git log 最后一次提交和下方说明；daemon 上的安装源在清理后换成了钉住提交的 Git 源（Paseo 自己的 checkout，不依赖这个 synthetic workspace）。

## 已知问题 / 下一步

- 本机其他插件的 agent.create 钩子也作用于后台检查子 agent（learning-loop、dynamic-workflow、async-shell、visualize 注入了提示词和工具），每次检查的上下文更大；其中一个慢钩子曾让创建超时（已加重试）。
- 在这台 daemon 上建一个 agent 约 25 秒，设置按钮期间显示 “Setting up…”。
- 已有助手的模型 / 权限模式只能在 Paseo 自己的模型菜单里改（SDK 没有改已有 agent 配置的接口），设置页有说明。
- MCP 端口在重启后被占用时会换端口，已有的助手要 reload 才能重新拿到工具（会写日志）。
- 下一步：不调模型的确定性 watcher（URL、命令、文件，HeartBeat 2.0 的做法）；每周回顾；经 paseo-telegram 等渠道触达；连接器授权后的邮件 / 日历早报；多个助手。

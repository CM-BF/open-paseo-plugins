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
- [x] 共享层：时区工具（含夏令时）、时间表达式（in 2h / tomorrow 9am / weekdays 8:30 …）、调度判定，单测 24 个
- [x] 只读权限策略 + 单测 45 个
- [ ] 状态存储、活动日志、本机 Paseo 连接
- [ ] MCP HTTP relay 和工具（助手 / 后台检查两种角色）
- [ ] 后台检查执行器、投递队列、早报、跟进、提醒合并与去重
- [ ] 服务编排、钩子、RPC
- [ ] 客户端：Aide 主屏（需要你 / 计划 / 活动 / 关注列表）、设置页、聊天里的更新卡片、侧栏、⌘K
- [ ] OVERVIEW.md、README
- [ ] 装到主 daemon，用新建的测试助手在 Web UI 里走真实流程并截图
- [ ] 清理测试 fixture，交付说明

## 验证记录

（待填）

## 已知问题 / 下一步

（待填）

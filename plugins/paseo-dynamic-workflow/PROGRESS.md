# paseo-dynamic-workflow：进度记录

## 目标

把 Claude Code 的动态 workflow（`Workflow` 工具）复刻给 Paseo 里的任意 agent：agent 写一段 JavaScript 编排脚本，插件在后台执行，脚本里的 `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` 启动和编排真实的 Paseo 子 agent（任意 provider），跑完把结果作为 `<task-notification>` 投回发起的 agent。

## 参考来源

- Claude Code 2.1.291 自带的 `Workflow` 工具：工具 schema、描述和 workflow 编写参考从本机二进制的字符串里读出（`strings ~/.local/share/claude/versions/2.1.291`）。API：`agent(prompt, {label, phase, schema, model, effort, isolation:'worktree', agentType})`、`parallel(thunks)`（屏障，失败项为 null）、`pipeline(items, ...stages)`（无屏障，stage 收到 `(prev, original, index)`）、`phase(title)`、`log(msg)`、`args`、`budget {total, spent(), remaining()}`、`workflow(nameOrRef, args)`（嵌套一层）。`meta` 必须是第一条语句、纯字面量。禁止 `Date.now()` / `Math.random()` / 无参 `new Date()`。并发上限 min(16, CPU-2)，总 agent 上限 1000。`resumeFromRunId` 复用未改动的 `agent()` 结果。
- 本机 Claude 官方插件里的 workflow 脚本（`~/.claude/plugins/marketplaces/claude-plugins-official/plugins/*/workflows/*.js`）：真实用法样例。
- `/Users/citrine/Projects/Paseo/plugins/claude-workflows`：Claude workflow 进度查看插件（卡片 + 面板的交互方式）。
- `/Users/citrine/Projects/Paseo/plugins/paseo-async-shell`：给每个新 agent 注入 stdio MCP 服务器 + 系统提示的做法（shim + unix socket bridge + nonce 绑定 agent），以及把结果投回 agent 的做法。
- Hermes：`hermes-agent/optional-skills/autonomous-ai-agents/dynamic-workflow/SKILL.md`（官方 skill，侧重扇出方法论：独立单元、对抗验证、分波次）；社区插件 `lingjiuu/hermes-dynamic-workflows`（Python 沙箱、持久化/可 resume、内容寻址缓存、结构化输出工具重试 5 次、子 agent system prompt 保持一致以共享缓存）。
- pi：社区扩展 `Michaelliv/pi-dynamic-workflows`（acorn 校验 meta 和确定性、`node:vm` 执行、限流器）。

## 设计决定

| 决定 | 原因 |
| --- | --- |
| 子 agent 是真实的 Paseo agent（`paseo.agents.create`，`parent` = 发起者） | 任意 provider/模型都能当子 agent；出现在发起者的 Subagents 栏里，用户能看、能回答权限请求 |
| 子 agent 默认继承发起者的 provider、模型、模式、思考强度和 feature 值 | 和 Claude 一样默认继承会话模型；`model`/`effort`/`agentType` 覆盖 |
| `agentType` 对应 Paseo 的 agent profiles（名字或 id），另有内置 `general-purpose`、`explore`、`plan`、`verification` | Paseo 没有 Claude 的子 agent 注册表，profile 是最接近的概念 |
| 脚本在 worker thread 里的 `node:vm` 上下文执行，主线程负责建 agent | 死循环不会卡住插件进程，停止时可以直接 terminate worker；vm 不是安全边界（agent 本来就有 shell），只为确定性和防误用 |
| `meta` 和确定性检查用 acorn 在主线程做 | 和 Claude/pi 的错误提示一致，worker 里不需要依赖 |
| 结构化输出走提示词 + JSON 提取 + Ajv 校验 + 最多 3 次追问 | provider 无关；Paseo 的 `outputSchema` 只有 Codex/OpenCode 支持 |
| 工具入口：stdio MCP shim（claude/codex/opencode）+ CLI `paseo-workflow`（其他读系统提示的 provider，如 pi/omp） | 照搬 paseo-async-shell 已验证的做法；shim 路径稳定，插件更新不影响已保存的 agent 配置 |
| 结果投递：发起者空闲时 `send()` 一条 `<task-notification>`；忙时等 `agent.turn_ended` | 只有 interrupt/steer 两种模式；等空闲最可预测 |
| resume 缓存按 (prompt, 影响结果的 opts) 的哈希 + 出现次序匹配，label/phase 不参与 | 和 Hermes 一样对并发调度顺序不敏感；改 label 不使缓存失效 |
| 进度卡片由服务端 `timeline.append` 写进发起者时间线（同 id 覆盖更新） | provider 无关，不依赖识别各家 MCP 工具调用的名字 |
| 子 agent 完成后默认 archive | 避免几十个子 agent 堆在 Subagents 栏；面板里仍能打开 |

## 子任务

- [x] 调研：Claude Workflow 契约、Hermes skill/插件、pi 扩展、Paseo 插件 API（0.12.0）
- [x] 仓库规则：进度记录、主 daemon 验证、Web UI 截图（`../../AGENTS.md`）
- [x] 脚本解析：meta 字面量、确定性检查、TS 语法报错（`server/script-parse.ts`）
- [x] Worker 运行时：agent/parallel/pipeline/phase/log/args/budget/workflow，停止，卡死检测（`server/worker-source.ts`、`server/engine.ts`）
- [x] 子 agent 执行器：配置继承、agentType→profile、模型别名、effort、结构化输出与纠正、worktree 隔离、权限等待、超时、用量、archive（`server/agent-runner.ts`）
- [x] 持久化：run.json、journal.jsonl、script.js、result.json；resume 缓存（`server/run-store.ts`）
- [x] 通知投递：outbox、等空闲、插件重启后补投（`server/notifier.ts`）
- [x] MCP shim + CLI + unix socket bridge + nonce 绑定 + agent.create 注入（`server/scripts.ts`、`bridge.ts`、`agent-setup.ts`）
- [x] 编写参考（`docs/REFERENCE.md` → `server/reference.ts`）和工具描述（`server/prompts.ts`）
- [x] 客户端：时间线卡片、通知行、Dynamic workflows 面板、Command Center、`/dynamic-workflows`、设置页
- [x] 单测（57 个：解析、沙箱语义、缓存/resume、停止/跳过、上限、预算、卡死、JSON 提取、通知解析）
- [x] 装到主 daemon，用新建的测试 agent 跑真实 workflow：Claude Haiku 父 agent（6 个子 agent）、Codex 父 agent（worktree 隔离 + 跨 provider 子 agent）
- [x] 停止（卡片 Stop、面板 Stop run）、resume、插件重载时 interrupted、CLI 路径（pi）、保存的 workflow（`--name` 和 MCP `name`）、agent 自己写脚本
- [x] 窄屏截图、设置页截图、面板里展开 agent、子 agent transcript
- [x] OVERVIEW.md、README、manifest 名称和描述
- [ ] 清理测试 fixture（workspace、agent、worktree、测试 run），交付说明
## 验证记录

环境：主 daemon `srv_BSheQn5lzdEE`，Paseo 0.12.0，home `~/.paseo`，listen 127.0.0.1:6767；插件以目录源安装，路径 `open-paseo-plugins/plugins/paseo-dynamic-workflow`（worktree `sw/dynamic-workflow`）。Fixture：`~/plugin-test-2026-10-22-dwf`（git 仓库），workspace `wks_917a0fc65ab64be8`。截图用本机 headless Chrome（`--disable-features=LocalNetworkAccessChecks`）打开 `https://app.paseo.sh`、Direct connection 到 `localhost:6767`；Paseo 内置浏览器的后台标签页不绘制，`browser_screenshot` 报 `screenshot_no_frame`。

| 日期 | commit | 场景 | 结果 | 截图 |
| --- | --- | --- | --- | --- |
| 2026-10-22 | 33128f4 | Haiku 父 agent `145d61db` 经 MCP `workflow` 工具启动 `smoke-review`（run `wf_c48a1c35113b`）：pipeline review→verify，6 个 Haiku 子 agent，schema 校验 | completed，19.6s；通知投递后父 agent 总结了 4 个 bug | `docs/verification/2026-10-22-haiku-parent-card-completed-desktop.png` |
| 2026-10-22 | 16c405e | Web UI：卡片 Details 打开 Dynamic workflows 面板 | 面板显示阶段、6 个 agent、结果 | `docs/verification/2026-10-22-panel-completed-desktop.png` |
| 2026-10-22 | 16c405e | Codex（gpt-6-luna）父 agent `f7c8507e` 启动 `fix-in-worktrees`（run `wf_f6f0a49cb719`）：2 个 Codex 子 agent 各自在 worktree 里修 bug 并提交；1 个 `claude/claude-haiku-4-5` 子 agent | completed，18s；两个 worktree 都有提交；运行中卡片实时更新 | `docs/verification/2026-10-22-codex-parent-card-running-desktop.png` |
| 2026-10-22 | 355b472 | 通知行：`<task-notification>` 用户消息显示为一行 | 正常，Message 展开原文、Run 打开面板 | `docs/verification/2026-10-22-codex-parent-notice-row-desktop.png` |
| 2026-10-22 | 355b472 | pi 父 agent `30e4aee3`（不支持 MCP）按系统提示用 `paseo-workflow run --name stop-resume` 启动保存的 workflow（run `wf_ff97f20e6579`）；在卡片上点 Stop | 子 agent 被关闭并 archive；但运行记成 failed（WorkflowStopped），见下一行修复 | `docs/verification/2026-10-22-pi-cli-parent-card-running-desktop.png` |
| 2026-10-22 | 37c5c14 | 修复后：Haiku 父 agent 用 MCP `name: "stop-resume"` 启动（run `wf_19ce09414287`），在面板点 Stop run | Stopped，“stopped by the user” | `docs/verification/2026-10-22-panel-running-desktop.png`、`…-panel-stopped-by-user-desktop.png`、`…-panel-stopped-compact.png` |
| 2026-10-22 | 37c5c14 | pi 父 agent 用 `--resume wf_ff97f20e6579 --args-json '{"fast":true}'` 恢复（run `wf_6c72dcb615ea`） | quick 两个 agent 命中缓存（cached），slow 两个改了 prompt 的重新跑；completed | `docs/verification/2026-10-22-pi-resume-cached-desktop.png` |
| 2026-10-22 | b0dd649 | pi 父 agent 启动 `wf_30d50c309861`，slow 阶段运行中 `paseo plugin reload` | 记为 interrupted；两个运行中的子 agent closed + archived；重启后通知投递，父 agent 回复 | （无截图，`get_agent_status` / `get_agent_activity` 核对） |
| 2026-10-22 | 87ef8b1 | 面板展开已 archive 的子 agent，看 transcript | prompt、工具调用、回复都在；archive 的子 agent 不能开成标签页，所以 Open agent 只在未 archive 时显示 | `docs/verification/2026-10-22-panel-call-expanded-desktop.png`、`…-panel-transcript-archived-child-desktop.png` |
| 2026-10-22 | 37c5c14 | 设置页（Settings → Plugins → paseo-dynamic-workflow → Dynamic workflows） | 读写正常，Service 显示 bridge listening | `docs/verification/2026-10-22-settings-desktop.png`、`…-settings-service-desktop.png` |
| 2026-10-22 | 4ad7a47 | 新建 Haiku agent `95fa9403`，只说“Use a workflow to audit src/ …”，不给脚本（run `wf_85af947c1999`） | agent 自己写出合法脚本（纯字面量 meta、schema、`agentType: 'verification'`、0 个 bug 时提前退出），7 个子 agent，completed | `docs/verification/2026-10-22-haiku-self-authored-workflow-desktop.png` |
| 2026-10-22 | 4ad7a47 | 窄屏（500 宽）卡片和通知行 | 正常 | `docs/verification/2026-10-22-codex-card-and-notice-compact.png` |

## 已知问题 / 下一步

- token 用量取自各 provider 上报的 `lastUsage`：Claude 正常；Codex 报得很少（3 个子 agent 共 370 output），pi 报 0。`budget.spent()` 对 Codex/pi 子 agent 偏低。
- Paseo 会在第一条消息后给新 worktree 的分支改名；现在结束时读 git 的实际分支。`wf_f6f0a49cb719` 的通知里还是改名前的分支名（修复前的运行）。
- 已 archive 的子 agent 不能用 `navigation.openAgent` 打开；面板用 transcript 代替。
- 插件安装之前就存在的 agent 拿不到工具（Paseo 只在 agent.create 时注入）。
- Paseo 内置浏览器的后台标签页不绘制，截图要用本机 headless Chrome（见上面的环境说明和 `/tmp/dwf-build/tools/cdp.mjs` 的做法）。
- 未做：组合 pill（每个 agent 的运行中 workflow 计数）、暂停/继续。

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
- [x] 清理测试 fixture（workspace、agent、worktree、测试 run），交付说明
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
| 2026-10-22 | b0dd649 | pi 父 agent 启动 `wf_30d50c309861`，slow 阶段运行中 `paseo plugin reload` | 记为 interrupted；关停时 archive 子 agent 失败（插件日志：`Daemon client closed`），重启后的恢复逻辑把它们 archive 了；通知投递，父 agent 回复 | （无截图，`get_agent_status` / `get_agent_activity` 核对） |
| 2026-10-22 | 87ef8b1 | 面板展开已 archive 的子 agent，看 transcript | prompt、工具调用、回复都在；archive 的子 agent 不能开成标签页，所以 Open agent 只在未 archive 时显示 | `docs/verification/2026-10-22-panel-call-expanded-desktop.png`、`…-panel-transcript-archived-child-desktop.png` |
| 2026-10-22 | 37c5c14 | 设置页（Settings → Plugins → paseo-dynamic-workflow → Dynamic workflows） | 读写正常，Service 显示 bridge listening | `docs/verification/2026-10-22-settings-desktop.png`、`…-settings-service-desktop.png` |
| 2026-10-22 | 4ad7a47 | 新建 Haiku agent `95fa9403`，只说“Use a workflow to audit src/ …”，不给脚本（run `wf_85af947c1999`） | agent 自己写出合法脚本（纯字面量 meta、schema、`agentType: 'verification'`、0 个 bug 时提前退出），7 个子 agent，completed | `docs/verification/2026-10-22-haiku-self-authored-workflow-desktop.png` |
| 2026-10-22 | 4ad7a47 | 窄屏（500 宽）卡片和通知行 | 正常 | `docs/verification/2026-10-22-codex-card-and-notice-compact.png` |

## 交付状态（2026-10-22）

- 主 daemon 上装的是目录源 `/Users/citrine/Projects/flowly-kanban/usage-cecf/open-paseo-plugins/plugins/paseo-dynamic-workflow`（synthetic workspace 的 worktree，分支 `sw/dynamic-workflow`），状态 running。这个 worktree 删除之前要先换源：合并到 main 后 `paseo plugin remove paseo-dynamic-workflow`，再从 main 的 checkout（`/Users/citrine/Projects/flowly-kanban/open-paseo-plugins/plugins/paseo-dynamic-workflow`，先 `npm ci`）或 Git 源重新安装。安装前 daemon 上没有这个插件，没有要恢复的旧来源。
- 默认对所有新建 agent 注入工具和系统提示（设置里可关）。状态目录 `~/.paseo/paseo-dynamic-workflow/`；测试 run 已删除，`bindings.json` 里留有测试 agent 的 nonce（无害）。
- 已清理：测试 workspace `wks_917a0fc65ab64be8`、两个 worktree workspace、4 个父 agent 和全部子 agent（archive），fixture 目录 `~/plugin-test-2026-10-22-dwf`，headless Chrome 和它的 profile，Paseo 浏览器标签页。

## 已知问题 / 下一步

- token 用量取自各 provider 上报的 `lastUsage`：Claude 正常；Codex 报得很少（3 个子 agent 共 370 output），pi 报 0。`budget.spent()` 对 Codex/pi 子 agent 偏低。
- Paseo 会在第一条消息后给新 worktree 的分支改名；现在结束时读 git 的实际分支。`wf_f6f0a49cb719` 的通知里还是改名前的分支名（修复前的运行）。
- 已 archive 的子 agent 不能用 `navigation.openAgent` 打开；面板用 transcript 代替。
- 插件安装之前就存在的 agent 拿不到工具（Paseo 只在 agent.create 时注入）。
- Paseo 内置浏览器的后台标签页不绘制，截图要用本机 headless Chrome（见上面的环境说明和 `/tmp/dwf-build/tools/cdp.mjs` 的做法）。
- 未做：组合 pill（每个 agent 的运行中 workflow 计数）、暂停/继续。

## Review 修复：客户端和运行视图（2026-10-22）

- 已修复（commit `38108a8`）：每阶段先显示运行中、需权限和失败的调用，按 50 行展开更多，超过第 120 个的调用仍可操作；运行详情按 `runId` 重置局部状态。
- 实时轮询使用精简视图：只保留调用元数据，结果与错误在展开调用时单独读取；只传最近 20 条、每条截短的日志。运行时钟独立刷新，调用行 memo，只有展开行订阅子 agent 缓存和完整详情。
- 设置改为本地草稿与显式 Save settings，一次写入完整文档和当前 revision；空数字与越界值显示校验错误，保存失败可 Reload 存储值。
- Transcript 在调用从 live 变为结束时补刷，并提供 Refresh；Skip 显示 pending 且请求后刷新运行；计数区分 running 和 queued，旧卡片的新计数默认 0。
- 原生布局补充文本收缩约束。通知包括失败原因和真实的 journal/run snapshot 位置，恢复提示保留 args；运行目录不再标为 transcript 目录。
- 验证：`npx vitest run server/views.test.ts client/settings-input.test.ts shared/notification.test.ts client/format.test.ts`，4 个文件、11 个测试通过；代表性 200 调用的精简 JSON 小于完整视图的 1/3，仍保留全部调用 ID 和元数据；`git diff --check` 通过。
- Typecheck 当时仅报告并行修改中的 agent-runner 测试和 engine timer 类型错误，客户端/共享契约/views 无错误。尚未在本轮 daemon/Web UI/iOS/Android 上验证；未操作 daemon。`server/contribute.ts` 新详情 RPC 注册由主 agent 和其余服务修改一并提交。

## Review follow-up: runtime (2026-10-22)

- 已修复：watchdog 仅接受 ping/pong；worker 日志/phase 每秒最多 100 条（日志 2000 字符，丢弃数量有汇总），请求总数和待处理 JSON 大小有上限，journal 合并同批写入，避免忘记 await 的循环淹没插件进程。
- 已修复：排队 agent 获得并发槽后再次检查 token 预算；排队 Skip 立即返回 null；Stop/interrupt 先终止 worker 并最多等待子 agent 清理 1 秒，清除等待 timer，忽略结束后的状态/用量回调；创建前 await 持久化预分配的子 agent ID，`finished` 等待异步收尾。
- 已修复：严格模式的脚本函数允许局部声明覆盖 API 名称；启动前编译检查；pipeline 遇到 null 后跳过余下阶段；嵌套 workflow 使用独立上下文，无法经 globalThis 绕过一层限制；提供 run 范围的 setTimeout/clearTimeout；封堵 Date constructor 与 Intl 无日期格式化的确定性漏洞；combinator 上限为 4096。
- 已修复：resume 缓存按原始 callId 调用顺序重放相同 key，保留 worktree 元数据；run.json 可保存 args/sourcePath（服务层写入和提示另行验证）；预算简写仅在消息首尾识别，避免中间 diff 统计被当成预算。
- 验证：`npx vitest run server/engine.test.ts server/engine-regressions.test.ts server/script-parse.test.ts server/budget.test.ts`，4 files / 70 tests 通过；包含预算排队、立即 Skip、日志/phase/请求死循环、严格模式、嵌套全局、timer、恢复顺序与 worktree、配置失败抛出及异步收尾。`npx tsc --noEmit` 与 `git diff --check` 通过。尚未在 daemon/Web UI 验证这些变更，插件保持原状态；全量测试由整合阶段执行。

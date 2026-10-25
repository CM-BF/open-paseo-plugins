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

## Review 修复：服务与传输（2026-10-22）

- 复用 Claude review `wf_c0e2e361-09e` 的已有输出；恢复后得到 84 条保留意见、4 条反驳及 79 项建议，含重复条目。不是 84 个独立问题；部分仅一位 verifier 确认。
- 修复 outbox 临时 refresh 错误丢通知、模糊 receipt 阻塞后续通知、关闭时投递竞态；模糊项保留 `uncertain:true` 供检查。
- 命名脚本返回独立 run 副本；保存 args/sourcePath，resume 继承 args；补终态未通知结果恢复、延迟 launch 对 dispose 的检查、即时 Stop 确认、保存/卡片重试/计时器清理。
- 历史列表使用摘要索引，完整记录 LRU 最多 100 条，避免每轮读全盘和无限保留结果正文。
- 限制 bridge caller 读取/停止/resume 自己的运行，拒绝子 workflow 递归启动；2MiB 请求明确 413；只重试连接前错误，避免重复 launch；CLI 拒绝未知参数；OpenCode 默认走 CLI 以共享服务。
- 新增 label sweep 恢复丢失 create 响应的子 agent；新隔离 agent 的 base SHA 用于判断未修改 worktree；旧运行缺少 base 信息时保留现场。
- 第二轮独立复核发现并修复：dispose 后延迟 launch、终态未排队通知漏恢复、startup 在 cleanup 后继续启动。
- 验证：目前全套 128 测试通过、typecheck 通过；之后增加了两个 service 关闭/恢复用例，局部 5 项通过。daemon 暂未启用，无 UI 验收声明。
- 当前限制：Paseo0.12 的 server entry 没有 PaseoApi；中途 reload 后需等 hook/RPC，错误提示明确要求打开面板一次。运行历史保留，不自动删除。预算依赖 provider 上报，内置角色是提示而非强制只读；文档已更正。

## Review 修复：启动、关闭和恢复回归验证（2026-10-22）

- `server/contribute.test.ts`：使用临时状态目录和最小 host 注册桩，验证 cleanup 先于异步 startup 完成时不会事后打开 bridge；正常启动后的关闭也使真实 Unix socket 不可连接。两条路径均检查零残留 timer，启动抢跑路径检查 rejection listener 已释放。
- `server/recovery.test.ts`：按 label 找回未保存 create 响应的子 agent（含分页），排除无关 agent，保护父 workspace/目录；使用真实临时 git 仓库和 worktree，验证只有未改动的子 worktree 会移除，未提交/已提交成果均保留，失败 teardown 标成 `changed:null`。
- 额外发现并修复：archive 返回成功但目录仍存在时，恢复逻辑之前误标为“已移除”。新增用例先出现 `changed:false` 的红灯结果；主 agent 增加实际目录检查后转绿，保留路径并标为 `changed:null`。
- 验证：`npx vitest run server/contribute.test.ts server/recovery.test.ts`，2 个文件、11 个测试全部通过；`npm run typecheck` 通过。本组为本地回归测试，不代替 daemon/Web UI 验收；没有操作主 daemon。

### 2026-10-22 review：子 agent 执行器与 schema 回归修复

- 模型：无模型的父 agent、provider 覆盖、无模型 profile 优先解析 catalog 的默认模型；catalog 不可用时使用 daemon `normalizeConfig` 支持的 `/default` 哨兵。完整 upstream/model id 优先匹配本 provider 的模型，只有已注册的 Paseo provider 前缀才切换 provider；限定 provider 后仍解析别名。模型缓存按 provider + cwd 隔离。
- 权限：每次调用读取父 agent 当前模式，按 catalog 元数据同时约束启动时和当前模式；不从缺少 `colorTier` 的 runtime `availableModes` 推测权限。跨 provider 无等价权限模式时报明确错误；Codex 限制使用已公布的 `auto` 模式加原生 `sandbox_mode: read-only` / `approval_policy: on-request`（规划时加 plan_mode），不传 catalog 拒绝的隐藏 `read-only` 模式。profile 也受父权限上限约束，陈旧的 auto_accept 授权与父 agent 当前值取交集。内置角色的禁止写入仍是提示约定，不能作为文件系统隔离保证。
- 生命周期：先持久化 caller-selected agentId，再以稳定 idempotencyKey 创建；先订阅真实 turn_canceled 事件，再发送初始提示，防止短 turn 的 Stop 被当作完成。archive/closed 结果返回 skipped，schema 纠正前再次 refresh，避免复活已归档 agent。连接中断重试 wait/refresh/send/archive，send 使用稳定 messageId；用户取消能中断重试等待。创建/配置失败和 schema 纠正耗尽抛给 workflow；已开始的 provider 运行失败保留 null 结果语义。失败时补计 provider 新暴露的未完成 usage，不重复计入上一纠正 turn 的旧快照。
- cwd：不同目录通过显式 workspace 的 agents.create 并保留 parent 链接；workspace 将目录折叠到别处时明确拒绝，提示使用 worktree。目录比较识别符号链接。
- worktree：唯一部分在前、最多 50 字符的分支名；预建分支固定到不可变 HEAD SHA，再用 checkout-branch 创建，避免 daemon 自动改名的竞态；base SHA 写入子 agent label 供重启恢复。仅当干净 worktree 已确认从磁盘移除、当前分支仍是本调用创建的分支且 SHA 等于 base，才删除该分支。用户已有分支、脏目录、有提交的 worktree 均保留；workspace archive 返回 error 或目录仍存在时报告并保留。关闭 Archive finished agents 时，成功的干净 worktree 和子 agent 也保留，并返回 retained:true；失败/取消仍执行清理。
- JSON Schema：支持显式 draft-07、2020-12 和旧式 tuple items；draft-04/未知 dialect 返回可操作的错误。提前拒绝明显不可能的 required:false 属性和必需值的矛盾边界；不把可选的禁止属性或条件分支当作全局不可能，也不宣称能判定任意 schema 的可满足性。
- 本地验证：13 个 runner 回归测试在旧实现上全部为红；最终 `npm run typecheck` 与 runner/schema 共 47 个测试通过。测试使用 fake SDK（含真实 createPaseoApi 转换）和真实临时 git 仓库，覆盖默认模型、slash id、模式收紧、取消/归档、断连、延迟创建、usage、1000 个分支名的唯一性、干净/脏/有提交目录、已有分支保护和清理失败。本项未操作 daemon；真实 daemon/Web UI 验证由主 agent 记录。
- 保留限制：provider 不上报的中止 turn tokens 无法由插件恢复；原生 providerOptions 未出现在公共父 agent snapshot 时，插件无法逐项继承/比较任意原生配置。停止期间尚未返回的创建由提前持久化的 ID 和 LABEL_RUN 恢复扫描兜底；硬终止在预建分支与发出 create 之间的极短窗口可能留下空分支。

## Review 修复：停止时的最终用量（2026-10-22）

- 第二轮交叉检查发现：engine 在触发子 agent 的 abort 前就屏蔽所有用量回调，使 runner 刚补上的 partial usage 被丢弃。现将状态冻结与用量冻结分开：收尾的 1 秒窗口内计入最终用量，窗口结束后保持快照/通知不再变化。
- 验证：两个 engine 测试文件共 41 项通过；覆盖清理期间用量计入但不恢复 running 状态，以及超过清理截止时间后的用量回调不再更新已结束运行。完整 `npx tsc --noEmit` 通过。尚未做本轮 daemon/Web UI 验证。

## Review 修复：重复 prompt 的失败位置（2026-10-22）

- 独立交叉复核发现：缓存只收集成功调用时，同 key 的第一次失败、第二次成功会在恢复时把第二个结果错配给第一个调用。现在 journal 恢复保留失败/跳过调用的空槽；空槽消耗原调用位置并触发重跑，后续成功结果仍命中原位置。可复用缓存数量只统计成功结果。
- 验证：两个 engine 测试文件共 42 项通过；新增 `[null, 'a2']` 同 prompt 运行恢复后只重跑 `a1`、保留 `a2` 结果的契约用例。完整 `npx tsc --noEmit` 通过；本项未操作 daemon。

### 服务修复最终补充（2026-10-22）

- 第二轮修复停止后延迟 launch、终态未通知补恢复、异步 startup 与 cleanup 竞态；关闭时 PaseoApi 保留到子 agent 清理完成，之后才 dispose Gate（真实 disable 测试确认子 agent 已 archive）。
- 新建隔离调用在创建前保存 pendingBranch，终止通知保留未完成创建/清理信息；worktree.changed:null 不再从通知隐藏。archiveFinishedAgents=false 的未修改隔离工作区以 retained:true 保留。
- 恢复按 id+label 查找子 agent，base SHA 判断工作区内容，archive 后核对实际目录是否移除；未知删除结果保留现场。
- 全套最终检查：18 个测试文件、159 项通过；typecheck 与 diff --check 通过。逐项原始 review 处理见 docs/REVIEW.md，平台限制与未实机验证项单列。

## Review 最终验收与交付（2026-10-22）

主 daemon：`srv_BSheQn5lzdEE`，Paseo `0.12.0`，home `~/.paseo`，listen `127.0.0.1:6767`。测试代码对应 `971c7e9`（含此前 runner/runtime/client 修复）。没有重启 daemon。

Fixture：`~/plugin-test-2026-10-22-dwf-review`，project `prj_8474b59633637446`，workspace `wks_4a08cd7602017f38`，父 agent `82cbff08-6c42-4ebc-9eac-026cedc5385c`，Codex/gpt-6-luna/low。Paseo 内置浏览器能 snapshot 但仍未绘制，截图改用真实 headless Chrome 打开 `app.paseo.sh`，目标 host 与 daemon serverId 一致；侧栏隐藏以避开无关会话。420×860 截图使用 CDP 原生设备尺寸并在 resize 后重新选择 fixture 运行，不是模拟页面。

| 场景 | 运行/结果 | 截图（docs/verification/） |
| --- | --- | --- |
| 新 agent MCP 注入、真实 pipeline/schema、完成通知回投 | `wf_3b180430cea9`，两个真实子 agent 均 completed，父 agent 收到通知；result 为 marker + verified1/2 | `2026-10-22-review-panel-desktop.png`、`…-panel-compact.png` |
| 已 archive 子 agent transcript | 在面板展开 fixture:2，看到完整最终 JSON reply | `2026-10-22-review-panel-compact.png` |
| CLI resume、继承 args 与缓存 | `wf_43140542a329`，两项 cached，无新子 agent，marker 原值保留 | `2026-10-22-review-resume-desktop.png` |
| 大运行分页、错误详情、compact 换行 | `wf_f16741d48c68`，129 个真实 agent() 配置校验失败（cwd 不存在；零模型调用），分页到129并展开错误，桌面和420px均可见 | `2026-10-22-review-scale-row129-desktop.png`、`…-scale-row129-compact.png` |
| 数字设置显式保存与持久化 | time limit 输入17，Save 后刷新仍17；随后恢复原值0，刷新核对0。并发0、总数1000均保持原值 | `2026-10-22-review-settings-desktop.png`、`…-settings-compact.png` |
| 面板 Stop | `wf_e4d9cf17a1aa`，Timer fixture 立即转 Stopped，通知正常 | `2026-10-22-review-stop-desktop.png` |
| 运行中 reload | `wf_d7336340ff0d`，timer 正在运行时 reload，变 Interrupted，卡片/面板同步更新 | `2026-10-22-review-interrupted-desktop.png` |
| 真实 worktree 创建与清理 | `wf_1910a6176ef4`，一个真实 Codex 子 agent schema 通过；未修改 worktree 已移除，git branch 只剩 main、worktree list 只剩 fixture 原目录 | API、run.json 与 git 核对，无单独截图 |
| reload 后恢复归档运行中子 agent | `wf_37862375682e`，sleep 子 agent 在 reload 后归档 | agent inspect：Archived=true；无单独截图 |
| disable 时直接归档运行中子 agent | `wf_2dc445d0dd17`，修复 Gate 关闭顺序后 disable；子 agent `d2311337` 在同次 cleanup 已 archive，未依赖重新 enable | agent inspect：Archived=true；插件停止记录无新的归档失败 |

最终检查：18 个测试文件、159 项通过，`npm run typecheck` 与 `git diff --check` 通过。原生 iOS/Android、真实跨 provider 受限模式、provider 额度限制/网络中断未作本轮实机测试；相应状态/权限/重试有行为回归，不能当作实机验收。

清理与当前状态：

- 插件恢复到任务开始时的 **disabled**，来源没有变化：`/Users/citrine/Projects/flowly-kanban/usage-cecf/open-paseo-plugins/plugins/paseo-dynamic-workflow`。该源仍是 `sw/dynamic-workflow` 的 workspace worktree；删除此 worktree 前应换到稳定 checkout/Git 源。
- 新建测试父 agent 和5个子 agent均 archive；fixture workspace archive、project delete；工作目录已删除。8个测试run、相应outbox和binding条目已从插件状态移除。native Web UI 确认为 Workspace unavailable，CLI workspace list 不含fixture，插件状态扫描为0个fixture run/outbox。
- 本次state备份和运行证据保留在 `~/.paseo/verification/dwf-review-2026-10-22/`，未用备份覆盖用户运行期间的其他数据。
- Headless Chrome、其profile、Paseo浏览器标签已关闭/清理。只操作本次插件和fixture，没有更改其他插件。
- 历史“交付状态”中的 running 描述属于前次交付，**以此处 disabled 为最终状态**。

## 发布到远程 main（2026-10-22）

- 用户明确要求发布到 `origin/main`，插件保持在 `plugins/paseo-dynamic-workflow/`。仓库 `AGENTS.md` 新增强制目录规范：所有插件必须位于 `plugins/<id>/`，禁止放在仓库根目录或其他顶级目录；`CLAUDE.md` 通过 `@AGENTS.md` 引用同一规则。
- 发布范围为完整插件、仓库开发规则/README 和验收辅助脚本，没有其他插件改动。远程 main 的初始提交是当前分支祖先，可常规快进，不覆盖已有历史。
- 发布前检查：全部被跟踪 manifest 均符合 `plugins/<id>/paseo-plugin.json`；Git 安装路径与 build 已配置；`git diff --check` 通过。上一轮159项测试、typecheck与主daemon验收已完成，本次只改目录规则和发布文案。

## 按 agent 开启 workflow：服务端（2026-10-22）

- 新增 `agent-access.json`，默认全部关闭，按 agent ID 保存显式授权；读取失败保持关闭。写入串行、原子替换，持久化成功后才公布状态，写失败回报调用方且后续仍可重试。
- 新增 `agent-access.get/set` RPC；核对真实 agent，拒绝不存在或已归档的 agent，以及给 workflow 子 agent 开启权限；关闭期间拒绝延迟完成的修改。创建时显式 `PASEO_DYNAMIC_WORKFLOW_ENABLED=1` 可授权，resume/refresh 和子 agent 不继承此开关。
- bridge 工具发现按 caller 返回描述，未开启时为空；未开启的 launch/reference 返回操作提示，已有运行仍可查状态或停止；没有通过 MCP 开启权限的工具。
- 本地验证：`npx vitest run server/agent-access.test.ts server/bridge.test.ts server/contribute.test.ts`，3 文件、18 项通过；覆盖并发保存、写失败、重启、真实 Unix socket、不同 caller、RPC 输入对象状态和 shutdown 竞态。`git diff --check` 通过。全量检查与 daemon/Web UI 验收由整合阶段完成，本项未操作 daemon。
- 接口补充 `hasMcpBinding`：区分新 agent 的已知 MCP 绑定和历史上未注入端点的 agent；后者即使是 Claude/Codex 也提供 CLI 路径，不能误称 Reload 就能补装。该标记只说明保存过绑定，不保证端点当前可达；RPC 用例覆盖已有/缺少绑定。

## 按 agent 开启 workflow：客户端（2026-10-22）

- Dynamic workflows 面板顶部新增独立 agent 开关，无运行时也可见；只在面板打开时读取该 agent 的状态，不增加全局 agent 轮询。保存期间禁用开关，成功后更新对应缓存，读取与保存失败就地显示。
- `/dynamic-workflows` 和 Command Center 的 “Dynamic workflow tools and runs” 均可进入。workflow 子 agent 不允许开启；Claude/Codex 提示从 agent 菜单 Reload 刷新工具列表（不承诺 Codex 自动刷新）；其他 provider 开启后显示可复制的 CLI reference 命令，用户可放入下一条提示，不自动发送消息。
- 全局设置移除 “Add workflow tools to new agents”，改为按 agent 开启的入口说明；保留工具预批准与运行设置。preferences v2 迁移丢弃旧的全局注入开关，其余字段按新 schema 保留。
- 局部检查：`git diff --check` 通过；typecheck 仅剩并行后端修改中的两个 bridge.test.ts 缺少 access fixture 错误，客户端与设置 schema 无类型错误。尚未进行本次主 daemon/Web UI 验收，由整合阶段记录。

### 按 agent 开启：旧 agent 入口补充

- 独立复核确认：插件未安装或禁用时创建的 Claude/Codex agent 没有 workflow MCP 配置，Reload 不能补加。客户端现在同时检查 provider family 和服务端 `hasMcpBinding`，仅已配置 MCP 的 agent 显示 Reload 提示。
- 未配置 MCP 的旧 agent 开启后显示 CLI reference 命令，并说明也可创建新 agent 使用 MCP 工具；不把 Reload 描述为补装工具的方式，不自动发送消息。
- 验证：`npm run typecheck` 与 `git diff --check` 通过；主 daemon/Web UI 场景由整合阶段验收。

### 2026-10-22：默认空 MCP 目录与配置清理

- MCP shim 默认返回空工具列表，只有调用者 agent ID 在持久化开启列表中才返回四个工具描述；监听原子替换的状态文件，发送 `tools/list_changed`。缺失/损坏状态与未知绑定均关闭。
- 新建会话不再默认注入 workflow 系统提示；复制配置时清理旧提示并重新绑定 nonce，workflow 子 agent 清理继承的端点、预授权和显式开启标记。CLI provider 仅在创建时显式传 `PASEO_DYNAMIC_WORKFLOW_ENABLED=1` 才注入提示。
- 本地配置与真实 MCP 子进程回归已通过：默认空目录、A/B隔离、启停通知、迟到的绑定、失效状态、stdin关闭后退出；设置迁移保留其他参数。主 daemon 两个新建 Codex agent 均回复 workflowTools=[]；开关实机验证尚在进行。

## 按 agent 开启：最终验证与交付（2026-10-22）

- 默认每个 agent 关闭；`/dynamic-workflows` 或 Command Center 的 Dynamic workflow tools and runs 打开该 agent 的开关。状态文件 `agent-access.json` 与 host 通用设置分开；旧全局注入设置迁移时移除，其他设置保留。
- 关闭时 MCP `tools/list` 返回空数组，不向新 agent 注入 workflow 系统提示。开启后只给该 agent 公布四个工具。Bridge 同步拒绝关闭 agent 的新 launch/reference，既有运行仍可查/停/接收通知。
- 独立复核修复：工具列表响应（含 batch）与状态通知按输出顺序串行，防止陈旧列表覆盖新的开关；shim 和服务端都拒绝混合类型/未知版本状态；未知 nonce 不回退到另一 agent header；旧会话缺少 MCP 绑定时显示 CLI 路径，不误导用户 Reload 可以安装 MCP。
- 当前 Codex 0.154.0 需要 Reload agent 刷新工具列表；Claude 的 installed 2.1.291 有变更通知处理代码，但本轮未实机验证 Claude 动态刷新。Paseo 0.12 不能通过公共插件 API 改写已有 session 的 systemPrompt/MCP 配置，所以旧提示和历史消息保留。原生手机未验证；窄宽度为真实 Web UI 420×860。

本地检查：22 个文件、179 项测试通过；`npm run typecheck`、`git diff --check` 通过。新增实际 MCP 子进程、实际 Unix socket、状态重启、配置继承/子 agent 排除、RPC 生命周期与设置迁移测试。通知顺序的两个确定性回归在修复前均失败，修复后通过。

实机：主 daemon `srv_BSheQn5lzdEE`，Paseo 0.12.0，127.0.0.1:6767。代码为 `fa7e41f` 加本节同提交的 nonce 校验；本轮开始时插件已被启用，结束时保持 **running/enabled**。来源仍为 `/Users/citrine/Projects/flowly-kanban/usage-cecf/open-paseo-plugins/plugins/paseo-dynamic-workflow`（当前 worktree 目录源）；删除 worktree 前需切换到稳定 checkout/Git 源。没有重启 daemon。

Fixture：`~/plugin-test-2026-10-22-dwf-optin`，project `prj_36afb70a124afaaa`，workspace `wks_573e79b877a9f82c`；Codex/gpt-6-luna/low agents A=`6494c217-b1c6-4af2-91cd-0f15d448add0`、B=`6b557e5a-7ccc-47ec-be08-8020f5421119`。

| 场景 | 实测结果 | 截图（docs/verification/） |
| --- | --- | --- |
| 两个新 agent 默认关闭 | A/B 均报告实际工具列表中 workflowTools=[] | `2026-10-22-optin-off-desktop.png` |
| UI 只开启 A，刷新浏览器 | A 的开关仍 true；B 仍 false | `2026-10-22-optin-on-desktop.png`、`…-agent-b-off-desktop.png` |
| Reload A 后真实 MCP 调用 | A 调用 workflow_reference，运行无子 agent 的脚本；`wf_f1dff4c8a7c6` completed，结果 `{optIn:true}`；B 再次确认 [] | `2026-10-22-optin-run-desktop.png`、`…-on-compact.png` |
| UI 关闭 A | CLI reference 立即返回 workflow_disabled；Reload 后 A 报告 [] | 同 fixture 的消息和本地证据 |
| 通用设置迁移 | 显示按 agent 开启说明；原并发0、总数1000、超时0保留 | `2026-10-22-optin-settings-desktop.png` |

清理：两 agent 已 archive，workspace archive、project delete；fixture 目录、完成的 fixture run 已删除，开启列表和 outbox 中没有 fixture。Web UI 访问原 workspace 显示 Workspace unavailable。证据/安装前备份位于 `~/.paseo/verification/dwf-agent-optin-2026-10-22/`。归档 agent 的 nonce 映射保留，避免直接改写活跃插件的内存/持久化 binding；不能再借此启动 workflow，因为对应开关已关闭。历史摘要缓存可能在本进程保留已删除测试运行，归档 workspace 的面板已不可访问；未为清缓存再 reload。

操作失误记录：reload 没有可靠地受非 fixture 活动运行检查约束，误中断另一任务的两次运行：`wf_72355de8655f`（01:25:52 UTC）和其后续 `wf_5119f3a9d9e6`（01:28:14 UTC），各有3个子 agent。最后一次命令虽已打印活动运行，仍无条件执行 reload。已向用户说明；两份原脚本/journal/run.json 保留，均 `notified:true`，确认插件已向原 agent 投递中断通知，可由原 agent 使用 resumeFromRunId 恢复。没有自动重启，也未删除其记录。已把“每次 reload 都必须重新检查，检测到非 fixture 活动运行即中止，不能只打印后无条件继续”写入实机测试技能。

## Claude Code workflow 用法与 Ultracode（2026-10-22，完成）

### 起因与诊断

用户对比了 Codex agent `f66ffa4a`（gpt-6-astra，thinking ultra）跑的 workflow 和 Claude 会话跑的 workflow：前者只有 3 路调研 → 1 个质疑者 → 1 个汇总（5 个 agent），两次被插件 reload 中断后又缩成 3 个 agent、单阶段；后者每次上百个 agent（按维度审查 → 每条发现多票核实 → 完整性检查 → 汇总 → 修复）。

核实后的原因（设计审查 workflow `wf_bbcdf98d-234` 的四个视角与完整性检查确认）：
1. 插件没有 Ultracode。Claude 会话的大规模来自每轮注入的 “Ultracode is on…token cost is not a constraint” 提醒和 authoring reference 的 Ultracode 一节，不来自 API 本身。没有它时模型按“请求的规模”办事；Claude 自己非 Ultracode 时默认规模建议也是 medium（约 10 个 agent）。
2. 旧 REFERENCE 缺：Ultracode、“研究/审查/审计拿不准时偏向彻底”、五种可串联形态、多票核实代码、barrier 判别示例、组合式 loop-until-dry 示例。Codex 照抄代码示例：旧示例只有“每条发现一个 refuter”和只在有 budget 时才跑的循环。
3. 工具描述缺 “ultracode” 关键字和 Ultracode 两种 opt-in，没有内置命名 workflow，`workflow_disabled` 错误还教 agent 自己去 UI 打开开关（f66 照做了）。
4. 中断后缩水：两次中断都没有已完成的调用（cached 0），resume 不省钱；通知没说清楚丢了什么、怎么回收。中断本身由本插件的验收 reload 造成（见上一节的操作失误记录）。
5. 另外发现：Paseo 里启动的 Claude Code 2.1.291 默认把 MCP 工具藏在 tool search 后面，工具描述在模型决定是否 orchestrate 时根本不可见。

### 关键决定

| 决定 | 原因 |
| --- | --- |
| 每个 agent 一个 Ultracode 开关，打开即同时开启 workflow；关闭 workflow 时清掉 Ultracode | 一次操作；`agent-access.json` 仍是 version 1，只加可选的 `ultracodeAgentIds`，旧 shim 进程照常工作 |
| 模式通过多个通道送达：MCP initialize instructions（仅开启的 agent）、`workflow` 工具描述（带 `anthropic/alwaysLoad`）、reference 第一行、每次启动结果、每条通知的 `<guidance>` | Paseo 不能每轮注入提醒；Codex 0.154 不处理 list_changed；Claude 默认延迟加载 MCP 工具描述。没有实测证据前不去掉任何通道 |
| 规模建议设置 small/medium/large/unrestricted，默认 **unrestricted** | 用户的问题是规模太小；默认不限制建议规模，由请求决定深度。建议不是硬上限，Ultracode 不受约束 |
| shim 每个进程只读一次规模建议，改设置不发 list_changed | 否则所有开启的 Claude 会话 prompt cache 失效；当前值由启动结果/通知/reference 带到 |
| 统一三态计票（holds / refuted / cannot_check）：失败或无法检查不算票，多数才确认或驳回，否则 unverified 并返回 | 原来六处示例和脚本计票不一致，基础设施失败会被当成驳回 |
| 内置命名 workflow：deep-review、deep-research、design-panel、critique、verify-claims（原创脚本，共用 `workflows/_shared.js`，构建时注入） | 让任何 provider 直接用上 Claude 会话常用的审查 → 核实 → 完整性检查 → 汇总流程；同名保存文件覆盖内置，`builtin.<name>` 总是内置版本 |
| 脚本新增只读全局 `guidance {ultracode, size}`、`agent()` 新增 `timeoutMinutes`，标签清除控制/格式/bidi 字符和尖括号 | 内置 workflow 按模式自动缩放；卡在权限提示的子 agent 不会永远挡住 barrier；标签会进入通知 |
| resume 继承原 run 的 guidance，用户关闭 Ultracode 时使用当前模式 | 一般保持缓存；用户明确降低模式优先于复用缓存 |
| 同一条用户消息之后第 4 次启动起，启动结果和通知要求先向用户汇报再继续 | Ultracode 的“下一阶段”提示会让 agent 自动串联，需要软性检查点 |
| 通知里子 agent 的结果、错误、标签和 run 名不能闭合或伪造标签（结果 JSON 用 `<` 转义，保持合法） | 结果里可能有网页或代码文本 |
| 不复制 Claude Code 的专有文本和脚本 | 8 词 shingle 重合度检查（工具在 `/tmp/dwf-review/critique-scratch/completeness/overlap.mjs`，Claude 材料不进仓库）：REFERENCE 0.1%、prompts 0.0%、deep-research 0.1%、其他 0% |
| `scripts/safe-reload.mjs`：有其他 agent 的活动 run 时拒绝 reload | 中断别人的 run 是这次退化的直接诱因 |

### 子任务

- [x] 服务端：per-agent Ultracode、规模建议、guidance.json、shim 的 per-agent 描述和 instructions、alwaysLoad、命名 workflow 目录（0f2cf62, 1d4d3b6, 98fa102）
- [x] 客户端：面板 Ultracode 开关、设置页规模选择、Reload 提示（eaa8e1a, 98fa102）
- [x] REFERENCE 重写和工具描述（1d4d3b6, 4ae9f04）
- [x] 启动结果/通知重申模式、中断通知列出被切断的 agent（fad8468, 1d4d3b6）
- [x] 引擎：guidance 全局量、标签清理、timeoutMinutes（87fdd63）
- [x] 内置 workflow 五个及其测试（0c976f1, a288d9c）
- [x] 兼容性测试：冻结的旧 shim（`server/fixtures/mcp-fa7e41f.mjs`）对新状态文件、store/shim 一致性、RPC 和设置版本错位（98fa102）
- [x] 统一计票、resume 继承 guidance、串联检查点、通知转义、原创性改写（4ae9f04）
- [x] 实现审查的核实与完整性输出已恢复，复用结果归并并修复确认项；后续独立复查的模式切换竞态也已修复（4975377），未重跑原审查。
- [x] 主 daemon 实机验收及 fixture 清理；已观察与未观察范围见 `docs/verification/2026-10-22-ultracode.md`。

### 哪些 agent 能看到什么（发布后）

- 本插件版本之前启动的 agent 保持原 shim 进程，直到用户 Reload：fa7e41f 之前的 shim 不看开关就列出工具（bridge 仍拒绝未开启 agent 的启动）；fa7e41f 的 shim 按开关列工具，但不显示 Ultracode 文本。两者都能从启动结果、通知和 reference 第一行得到当前模式。`f66ffa4a` 属于前者。
- 新 shim：Ultracode 切换实时发 list_changed（Codex 仍需 Reload）；规模建议按进程固定；instructions 每次连接读取一次。
- CLI 型 agent（OpenCode、Pi、OMP、无 MCP 绑定的旧 agent）：从带 CLI 指引的模式消息、`paseo-workflow reference`、启动结果和通知获得当前模式。

### 回滚

恢复上一版本源码前：在面板关掉各 agent 的 Ultracode（或插件停止时手动编辑 `agent-access.json` 去掉 `ultracodeAgentIds`），删除 `~/.paseo/paseo-dynamic-workflow/guidance.json` 和 `workflows/`，再 Reload 受影响的 agent。旧服务端会拒绝只含 `ultracode` 的 RPC（版本错位时报错而不是悄悄关掉 agent）。

### 已知问题 / 未验证

- Codex 0.160.1（luna/astra）不会直接展示本插件 MCP 描述；U Reload 后已实际调用工具。Codex 如何利用 `_meta` / initialize instructions 尚未证明，模式消息已实机验证。
- Claude 2.1.291 的 alwaysLoad 与 MCP instructions 已通过 transcript 验证；list_changed 后刷新已加载描述未单独实机穷尽，保留 Reload 提示。
- 子 agent 拿到哪些 MCP 服务器（REFERENCE 的描述是推断）：未实测。
- shim 首次读取 guidance.json 失败时会在该进程内一直用默认值（unrestricted）。

### 接续：审查收敛与完成验收（2026-10-22）

Claude 额度耗尽后从已完成的记录接续，没有重跑原审查和 fixture。接续基线 `e55ca19`：typecheck、28 文件 / 225 测试通过。原实现审查的最终任务输出 `w3634wt08.output` 已完成核实和完整性检查，198 次 agent 调用（171 done、27 额度失败），只有最后汇总失败；零票项不当作已核实结论。遗留项分成通知/模式、内置脚本、reload 安全三组，用针对性回归重现后修复。

- Reload CLI：采用 daemon 提供的 `PASEO_CLI`，保留 `PASEO_BIN` 兼容；20 秒 deadline 比 30 秒 RPC 短，超时强制结束子进程并报告结果未知，失败显示 CLI stderr 的原因。三条针对性测试先红后绿（包括隔离的假 CLI 超时）。
- 面板明确启用工具后需 idle Reload，Codex 依赖它发现新工具；REFERENCE 补模式消息来源和显式 `args.size` 优先级。
- 完成态 Web UI 已核实，桌面与 420px 窄屏截图：`docs/verification/2026-10-22-ultracode-completed-{desktop,compact}.png`。
- 已完成其余确认项修复、最终部署/回归、fixture 清理；见末尾最终验收记录。

### 接续子任务：safe-reload 的目标与失败关闭（2026-10-22）

- 严格解析 `--allow`；`--allow --dry-run` 等缺少 ID 的输入在调用 CLI 前退出，防止把 dry-run 选项吞成 ID 后真的 reload。
- 优先使用 daemon 提供的 `PASEO_CLI`，兼容 `PASEO_BIN`，仅未指定时使用平台默认 CLI；指定的 CLI 无法执行时不回退。脚本仅支持本机 home，拒绝 `PASEO_HOST`。按已安装 CLI 的规则展开 `~`、默认值和相对 home；先读取 daemon status，要求 home 与所选目录实际相同、running/reachable、listen/serverId 存在，再扫描该 home。所有 CLI 调用显式传递同一 `--home`，实际 reload 前复核 home/listen/serverId，并把最终 run 扫描放在 mutation 前。
- 缺少 runs 目录、缺少/损坏 run.json、未知版本/状态、run ID 与目录不符、缺少 owner 均阻止 reload，不再静默跳过。仍存在扫描与 reload 之间新建 run 的短窗口，不能宣称原子安全。
- 验证：新建 `server/safe-reload.test.ts`，原实现 26 项中 21 项为红；修复后扩展为 30 项全部通过，`npm run typecheck`、目标文件 `git diff --check` 通过。测试仅执行临时假 CLI，覆盖精确 argv、带空格和 shell 字符的 home、CLI 优先级、tilde/default/relative home、远程环境目标、daemon 更换与无效状态、活动阻塞、dry-run、损坏/缺失记录。未 reload 或修改真实 daemon。

### 2026-10-22：交接后的通知与模式回归修复

- 真实复现并修复：ON/OFF 在 busy agent 上抵消导致 OFF 丢失、失败 ON 后重试旧模式、同 agent 并发 ON/OFF 读取旧状态。访问修改和通知按 agent 串行；每次切换总是保留最新模式消息，已尝试的旧模式 receipt 标成 superseded，不再投递。
- 已尝试的 run 通知不改正文或 messageId。仅明确失败的旧投递在正文变化时由新 ID 替代，持久化 logicalId 使后续刷新仍找到同一 run；正在投递时先等 receipt。`outcome_unknown` / `key_conflict` 的 run receipt 留在 outbox 隔离，**不换 ID 自动重发**，需先核对 timeline/receipt；独立的新用户模式切换事件仍可投递。
- CLI provider 和无 MCP binding 的旧 agent 收到 CLI reference/run 入口，不再误导它们靠 Reload 添加 MCP。关闭 workflow 的通知说明持续到用户再次开启；Ultracode 提示明确内置 workflow 默认不传 args.size，除非用户要求轻量运行，2048 字符截断约束仍通过。
- Reload RPC 在最后一次 refresh 后重新检查插件 shutdown 和 agent 是否存在/归档，避免清理后启动 CLI；通知的 cut-off 列表排除用户手动停止/归档的子 agent；含尖括号的恢复路径仅给可无损解析的 JSON 工具形式，避免替换字符后指向错误路径。
- 验证：先运行新增回归，确认旧实现失败；修复后 `npx vitest run server/notifier.test.ts server/contribute.test.ts server/views.test.ts server/service.test.ts server/mcp-guidance.test.ts` 为 5 文件、43 项通过，`npm run typecheck` 和 `git diff --check` 通过。未自行 reload daemon；实机验证由整合阶段完成。

### 2026-10-22：交接后内置 workflow 的核实修复

- 读取实现审查最新结果 `w3634wt08.output`（198 个 agent；171 完成，27 因 Claude 额度失败；critic 已完成，plan 未完成），复用已有发现和核实结果，没有重跑已完成的审查。原始输出及恢复摘要已持久保存到 `~/.paseo/verification/dwf-ultracode-2026-10-22/`。
- 内置结果新增 `limit: string | null`；首次 agent cap / token budget 拒绝后，共用包装器记录原因并短路后续调用，核实按批发出，避免异常日志淹没阶段日志。deep-review、deep-research、critique 在有显式 output-token budget 时尝试保留 15% 给最后的计划/汇总/修订；核实与 gap critic 到达该余量后停止。输出长度未知，所以这是尽力预留；没有宣称保留未知的 host agent cap，也没有新增 engine API。只有核实阶段的 verify-claims 不扣这份预留。
- 缺失投票或 cannot_check 都写入失败 coverage，并使结果 partial/inconclusive；已有多数票结论保留，真正分票仍保留 unverified，不改成单票确认。design-panel 的缺失评分、重复角度中的失败设计者和严重攻击后的失败修订均不再报告完整完成；未修订攻击用 `unaddressedRedTeam` 标明。
- deep-review 为 gap 发现保留一部分核实名额，干轮后释放剩余名额；去重保留标题词序，ID 按数字顺序决定同严重度名额。research 不再把未入批 claim 标成已处理，gap 结束后用完剩余名额，超出上限的 claims 列入 unverified；最终阶段失败写入 coverage，无法下结论时按实际缺口说明原因。
- 来源去重仅标准化 scheme/host 大小写并去已知 tracking 参数；保留 www、尾斜杠、路径/查询大小写、ref/source 参数和 hash 路由。verify-claims 修复用户 ID 和生成 ID 冲突。测试包装器现在记录异步拒绝，避免未预期的 agent 被静默吞掉。
- 本地验证：14 个新增测试在旧实现先失败；修复后 `npx vitest run server/builtin-workflows.test.ts` 30/30 通过（含预算保留、cap、最终汇总、跨 gap 严重发现、URL 身份、空/缺失投票等），`npm run typecheck` 和 `git diff --check` 通过。未在本子任务操作 daemon；整合后的实机验收由主任务记录。日志已持久保存到 `~/.paseo/verification/dwf-ultracode-2026-10-22/` 的 `builtin-regressions-red.log`、`builtin-final-tests.log`、`builtin-final-typecheck.log`。

- 后续交互检查补充：run 通知正在投递时 ON→OFF→ON 会清掉中间 OFF 的待替换内容，不能在一次明确失败后发出过时的 OFF。新增确定性回归先失败后通过。
- 操作失误：最初新增的两个 Reload RPC 红灯测试尚未 mock `./reload`，以模拟 agent ID `a` 调用了主 daemon CLI；CLI 把它当作前缀，实际刷新了此前的测试 agent B=`af28c02e-08b2-4609-9c72-954a293bb71a` 两次（2026-10-23 06:19:41.486 / 06:19:42.089 UTC）。证据为 `~/.paseo/20261022-2323-01-daemon.log` 第8969、8973行，均为 `Refreshing agent ... from persistence`。这不属于计划内验收；没有作用于用户真实 agent。发现后测试统一 mock Reload helper，之后的回归不接触真实 CLI；未自动重启或变更该 fixture 的其他状态。
- 补充来源身份检查：不排序查询参数，保留重复参数的顺序（`?a=1&a=2` 与 `?a=2&a=1`）；同一来源回归扩展后仍 30/30 通过。

### 接续整合：文档与完整回归（2026-10-22）

- README / OVERVIEW / authoring reference 对齐最新模式投递，不再声称 ON→OFF 不发送最新 OFF；明确 mode-change 通知可以报告用户的常驻 opt-in，run completion 不能授权新任务。
- Reference 说明内置 size 是深度、实际数量可超过同名通用建议；显式 args.size 的优先级；missing/cannot_check coverage、limit 和最终阶段尽力预算预留。重建 `server/reference.ts`，与原文一致。
- 整合 `ccbbda6`、`3460fd3`、`135e6f6`、`a02b73a`、`a5851ab`、`2f80146` 后：typecheck、29 文件 / 287 测试和 diff-check 全部通过。日志保存在 `~/.paseo/verification/dwf-ultracode-2026-10-22/final-tests.log`。

### 2026-10-22：模式 RPC 在异步校验前占位

- 最终独立审查发现：原先先 await agentAccess 再入队，旧 ON 的 refresh 较慢时，新 OFF 会先保存，旧 ON 随后反而覆盖用户最后的选择。现在 handler 在任何异步校验前同步登记每个 agent 的队列位置，agent 验证、保存和通知都在该位置内执行；失败不会污染后续操作，结束后仍清理队列。
- 新增确定性 fake API 回归，旧实现返回 ultracode=true（预期 false）而失败，修复后通过；所有 Reload helper 都 mock，未调用真实 CLI。局部 `server/contribute.test.ts`、`server/notifier.test.ts`、`server/service.test.ts` 通过，typecheck 和 diff-check 通过。


### 最终验收与清理（2026-10-22）

- 最终代码 `4975377`：typecheck、29 文件 / 288 测试、diff-check 通过；安全闸确认无活动 run 后 reload，主 daemon 0.12.0 正常 running。没有重启 daemon。daemon 输出的五个脚本和 reference 与源码逐字匹配。
- 最新 Web UI 已核对新提示，桌面与 420px 截图为 `docs/verification/2026-10-22-ultracode-final-{desktop,compact}.png`；U 的 Reload 在 23:28:54 成功，关闭后的 OFF 消息送达并得到回复。
- 原 fixture `wf_2d04ea7bb729` 的 18 个子调用全部完成、三种埋入缺陷均独立核实。U 显式选了 small，因此未实机覆盖 unrestricted 的完整性循环；新版加强默认不传 size 的指引，不能把这次成功夸大成全部内置深度通过。
- 五个父 agent 与 18 个子 agent 共 23 个按完整 ID 独立核对已 archive；原 project/workspace 不在原生列表，Web UI 显示 Workspace unavailable。repo 与测试 run 目录删除，开关/outbox 无 fixture。归档 nonce bindings 保留，不改活跃插件内存。截图 `2026-10-22-ultracode-cleanup-desktop.png`。
- 运行结果、journal、原审查输出、最终 transcript、测试日志和 cleanup.json 持久保存在 `~/.paseo/verification/dwf-ultracode-2026-10-22/`。Chrome 已关闭；临时 profile 与本任务 scratch 清理，不碰其他测试资源。
- daemon 当前目录源仍是本 workspace 的 `open-paseo-plugins/plugins/paseo-dynamic-workflow`。删除 worktree 前必须切换持久源；恢复来源、备份和尚未实测的边界详见 `docs/verification/2026-10-22-ultracode.md`。

## 对照原生 Workflow 的复刻审查（2026-10-24）

方法：主 agent（Claude Code 2.1.291，自带 Workflow）先用原生工具跑探针，取得真实的报错文本、null 语义、`<failures>`/`<recovery>`/`<usage>` 格式、子 agent prompt 外框和 resume 行为；再从本机二进制提取实现片段（只放在 `/tmp/dwf-parity`，不进仓库、不照抄文本）。审查 workflow `wf_9873805a-3b0`（10 个维度 → 合并 → 每条 3 个视角核实），会话结束时已完成 273 个 agent：158 条原始差异合并后 88 条有核实票，86 条确认。完整性检查与计划阶段未跑（会话结束），按用户要求改为自己实现。结果：`/tmp/dwf-parity/verified.json`。

已修复（每项先写回归测试）：
- 指引：只核实结论依赖的发现/主张，先合并重复；critic/synthesis 不喂全部 JSON；循环要有轮数上限；机械核查用 medium effort。起因是 agent 736de498 的调研脚本把 319 条“原子事实”各派 3 个核实者（957 个 agent），部分源于我们的 Ultracode 文案“check every claim… do not cap”。新增 REFERENCE「Mistakes that make a workflow too big」。
- `ultracode` 关键词视为请求 workflow（与原生一致），引用/询问该词不算；规模规则不再互相矛盾；通知声明不是用户输入或批准。
- 子 agent：固定的“脚本计算的任务”外框，每行缩进两格；转述触发本次的用户消息（≤4000 字符，兄弟 agent 前缀一致）；无条件禁止再开 agent/workflow；question/plan 类权限请求自动拒绝并让其按假设继续（工具权限仍由人回答）。
- resume：与原生一致只复用最长未改动前缀（新增 `agent_started` 日志行；第一个新增或改动的调用及其后全部重跑，并在日志说明）；失败或被停止切断的调用重跑但不终止复用；完成顺序无关；旧 journal 保持逐调用匹配。resume 链中间一次提前结束时，更早的结果仍可补位。
- 通知：`<failures>` 用 `[label] failed: msg`，并列出 `parallel[i]`/`pipeline[i]` 被拒的槽（相同消息合并计数）；`<usage>` 用 agents_done/agents_error/agents_skipped/agents_cut_off/agents_empty_result/agents_cached/subagent_tokens；用户手动停止的 run 不给 resume 提示；恢复提示指向子 agent transcript；CLI 提示用绝对路径。
- 启动：解析错误带出错行与插入符，并总是说明“必须是纯 JavaScript”；脚本错误指向 reference、去掉 `invalid_script:` 前缀；启动结果加入空缓存提醒和观看位置。
- reference 工具也 alwaysLoad；MCP 说明里写明在 Paseo 中优先用本插件；默认并发改为原生的 min(16, max(2, CPUs-2))。
- 卡死检测：10 分钟无活动（单个工具调用中 60 分钟）视为 stall，归档并重开，最多 3 次；面板新增 Restart；行内显示 attempt、工具调用数和最后一个工具。
- agentType 支持 Claude 名称（Explore/Plan/claude）和 `.claude/agents/<type>.md`（作为角色文本，不应用其工具限制/模型）；`model: 'inherit'`。

刻意保留（不同于原生，理由）：结构化输出仍是 prompt + JSON 提取 + 3 次纠正（跨 provider）；工具默认预批准（Codex 等每次弹窗更差）；预算按 run 计且只算子 agent（插件看不到父 agent 的用量）；resume 生成新 run id（卡片/历史按 run 展示）；规模建议默认 unrestricted（用户要求）。

本地检查：303 项测试、typecheck 通过。实机验收见下一节。

### 接续核验：resume 调用历史（2026-10-24）

- 自行复核发现先前 resume 修复尚不完整：按 key 独立匹配仍会复用重排/删除后的旧调用，跨 resume 链也可能把不同前缀同位置的结果拼起来。对照已保存的原生探针和引擎，缓存匹配现加入完整调用前缀；失败调用结束本次后续复用，只有被中断的在途调用可重跑后继续复用。
- 新回归先见 4 项失败，修复后覆盖新增/修改/重排/删除/重复、完成顺序、失败、中断和跨链不同前缀；9 项通过。同步更正 README / REFERENCE 中“失败后继续缓存”和“所有 pipeline 都全缓存”的过度承诺。
- 此处覆盖前一节关于失败调用不结束复用的旧结论。86 条是审查确认差异数，不能表述为 86 条全部修完；平台限制和剩余差异须按最终验收记录报告。

### 接续核验：重试分支恢复记录（2026-10-24）

- 重试实际使用 a1r2 等 attempt 调用 ID，原 `pendingBranch` 却仍记录 a1。若创建期间插件停止，恢复会查错分支。新增回归先失败，改为按本次 attempt ID 记录后 3 项 retry 回归通过；没有创建真实 worktree。
- 移除上一批误提交的 Finder `.DS_Store`。
- 迁移补充：旧格式（无 agent_started）的跨 resume 链按 callId 先合并再分组，避免把祖先同 key 的调用重复追加成不存在的缓存槽；新增回归先失败（size=4，预期2），修复后 10 项 resume 回归通过。

### 2026-10-24：接续实机验收与交付状态

- 最终运行代码 `94f9bda`：typecheck、33 文件 / 310 测试、diff-check 通过。本轮自行补上 resume 调用历史、旧日志跨链槽位和重试分支恢复的遗漏；新增回归均先红后绿。
- 主 daemon 0.12.0，server `srv_BSheQn5lzdEE`。空闲闸后改成 daemon 管理的本地 Git checkout，revision 固定 `94f9bdaa3fb8917e9018e13f346d842e2e288bef`，精确恢复 preferences，再安全 reload。没有重启 daemon或改动其他插件。来源不再依赖本 synthetic worktree。
- Codex 新 agent 通过真实 MCP 启动探针、收到卡片和完成通知；原脚本 resume 缓存3个成功结果，改第二个 prompt 后只缓存第一个；真实 UI Restart 换成 attempt 2，工具计数和结果回投可见。桌面与500px compact截图及完整边界见 `docs/verification/2026-10-24-parity.md`。
- Claude 新 fixture仍遇到额度限制，不能报通过。一次 Codex 子调用拒绝计算任务，原始输出保留，未改提示词规避。Restart结果含正确stdout和额外格式，未夸大为字节一致。
- 原审查86条确认差异按已处理/部分改善/保留差异/尚未对齐逐项记入 `docs/PARITY.md`；**不等于86条已全部修复，更不能称与原生完全无区别**。
- fixture的11个会话（含自动额度fallback）按完整ID核对归档；测试project/workspace、4个run和fixture repo清理。access/outbox无fixture，归档nonce binding保留。截图显示Workspace unavailable。原始结果、回归红绿日志、安装备份、cleanup.json保存在 `~/.paseo/verification/dwf-parity-2026-10-24/`。本地分支尚未push。

## 第二轮修复与发布（2026-10-25）

- 按用户决定：Claude agent 优先用原生 Workflow（工具描述、MCP 说明、模式消息、reference）；插件留给没有原生工具的 agent。
- 继续对齐：opt-in 成本理由、Ultracode 只在对话/琐碎回合不用 workflow 且不再要求第4次确认；运行时宽松处理（非字符串 prompt/label/phase、未知 effort/isolation 记日志、schema 根只要求 object、meta 可选字段错型忽略并保留 title、默认 label 前60字符、console 合并参数、函数结果报错、错误提示）；父 agent 自停不再追加通知；summary 用 description；截断按实际长度；缓存调用保留原子 agent；面板显示任务开头。台账：已处理 43、部分改善 16、保留差异 15、尚未对齐 12（见 docs/PARITY.md）。
- 314 项测试、typecheck 通过；推送远程 main `c62670f..c9beded`；daemon 更新到 `c9beded`（git 源 `file:///Users/citrine/Projects/flowly-kanban/open-paseo-plugins`），running，日志无启动错误，reference 输出含新文本。此前已用 Claude 父 agent（haiku）实测 `94f9bda`：结果与原生探针一致。
- 操作失误：更新脚本在连续 120 秒空闲后再检查一次才执行 `plugin update`，但 update 先拉取并构建，约 1 秒后才 reload；736de498 恰在这段时间 resume 了 `wf_25381c3c913a`（8 个缓存命中、1 个刚开始的调用），被 reload 记为 interrupted。中断通知已排队投递给 736de498，它可用 resumeFromRunId 继续（8 个结果仍可复用）。教训：`plugin update` 的构建时间不受空闲检查保护，应先 install/准备好再执行短暂 reload，或请运行方暂停启动。

# paseo-dynamic-workflow

把 Claude Code 的动态 workflow（`Workflow` 工具）带给 Paseo 里的任意 agent。agent 写一段 JavaScript 编排脚本，插件在 daemon 上后台执行；脚本里每个 `agent()` 都是一个真实的 Paseo 子 agent（任意 provider），结果回到脚本，整个运行结束后以 `<task-notification>` 消息投回发起的 agent。

脚本 API 和 Claude Code 一致：`agent(prompt, opts)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`phase()`、`log()`、`args`、`budget`、`workflow(nameOrRef, args)`，`meta` 必须是纯字面量，`Date.now()`/`Math.random()`/无参 `new Date()` 不可用，`resumeFromRunId` 复用未改动的 `agent()` 结果。完整参考见 [docs/REFERENCE.md](docs/REFERENCE.md)（agent 通过 `workflow_reference` 工具读到的就是这份）。

## 安装

需要 Paseo 0.12 或更新（daemon 和 App）。在 daemon 主机上：

```bash
cd plugins/paseo-dynamic-workflow && npm ci
paseo plugin install "$PWD"
# 也可以从 Git 安装（manifest 里的 build 会执行 npm ci --omit=dev）：
paseo plugin install 'git:https://github.com/CM-BF/open-paseo-plugins.git:plugins/paseo-dynamic-workflow'
```

安装后新建的 Claude/Codex agent 会连接一个默认返回空工具列表的 MCP 端点，不增加 workflow 系统提示或工具描述。每个 agent 单独开启；其他会话保持关闭。

## 用法

先在目标 agent 中输入 `/dynamic-workflows`，打开 **Enable workflow tools for this agent**。选择保存在 daemon 上，刷新界面后仍有效。启用工具后，等 agent 空闲时点击面板的 **Reload agent now** 或 agent 菜单的 **Reload**，让工具列表和 MCP instructions 刷新；已实测 Codex 0.160.1 需要 Reload。然后对 agent 说“用 workflow 做……”或在消息里写 `ultracode`（这些就是 opt-in，工具描述里写了规则）。agent 会先调 `workflow_reference` 读参考，再调 `workflow` 启动；工具立即返回 run id、脚本路径和运行目录，agent 结束这一轮，等通知到来。

**Ultracode**：同一面板的第二个开关，按 agent 保存。开启后 workflow 成为常驻 opt-in，agent 以最完整、最可靠的结果为目标而不是成本：每个实质任务都开 workflow，每个阶段一个 workflow，每条发现由独立 agent 多票核实，跑完整性检查和独立汇总。Paseo 无法像 Claude Code 那样每轮注入提醒，所以切换开关时插件给该 agent 发一条简短消息（空闲时投递，多次切换只保留最新的待发模式，对应 Claude Code 的进入/退出提醒），模式也写在 MCP instructions 和工具描述里（Reload 后生效），并在 reference 第一行、每次启动结果和每条完成通知里重申。实测 Paseo 里的 Codex 0.160.1（gpt-6-luna、gpt-6-astra）把 MCP 工具藏在 tool search 后面，模型一开始看不到 workflow 工具说明，所以对 Codex 而言这条消息才是 Ultracode 生效的途径。Claude 的 MCP 工具默认被 tool search 延迟加载，`workflow` 工具带 `anthropic/alwaysLoad`，开启的 agent 才会一直看到它的描述。

**规模建议**（设置里的 Workflow size guideline）：unrestricted（默认）/ small（约 5 个 agent）/ medium（约 10）/ large（约 50），对应 Claude Code 的 Dynamic workflow size；Ultracode agent 不受它约束。已在运行的 shim 保持启动时读到的值，避免改设置时让所有会话的 prompt cache 失效；启动结果和通知里是当前值。

**内置 workflow**：`deep-review`、`deep-research`、`design-panel`、`critique`、`verify-claims`，用 `workflow({ name, args })` 启动，都接受 `size`，不传时 Ultracode 下用 `unrestricted`；除非用户明确要求轻量运行，否则不要主动传较小的 `size`。内置流程的 size 表示各自的深度，实际 agent 数取决于发现数量和核实票数，可能超过同名规模建议。源码在 `workflows/`（共用部分 `workflows/_shared.js` 在构建时插入），运行时副本写在状态目录的 `workflows/` 下供 agent 读取 args。同名的保存文件会覆盖内置版本，`builtin.<name>` 总是运行内置版本。

- Claude / Codex：MCP 工具 `workflow`、`workflow_status`、`workflow_stop`、`workflow_reference`（Claude 里显示为 `mcp__dynamic_workflow__*`）。
- OpenCode / Pi / OMP，以及安装前没有 MCP 绑定的旧 Claude/Codex agent：开启后，面板提供 `paseo-workflow reference` 命令，把它加入下一条消息即可让 agent 读取用法。支持 `run --file x.js | --name <saved> [--args-json ...] [--resume <runId>]`、`status`、`stop`、`reference`。调用者由 Paseo 的 `PASEO_AGENT_ID` 识别。程序化创建可显式传 env `PASEO_DYNAMIC_WORKFLOW_ENABLED=1` 开启该 agent；CLI provider 此时会同时收到说明。
- 保存的 workflow：项目里的 `.paseo/workflows/<name>.js` 或 `.claude/workflows/<name>.js`（Claude Code 的保存 workflow 大多可以直接用；用了 Claude 自定义 agentType 的会报 Unknown agentType），以及 `~/.paseo/workflows/`、`~/.claude/workflows/`，最后是内置 workflow。

界面：发起 agent 的聊天里有运行卡片（阶段进度、运行中的 agent、最新日志、结果、Stop/Details）；Dynamic workflows 面板（卡片 Details、`/dynamic-workflows`、Command Center 的 Dynamic workflow tools and runs）提供本 agent 的开关，并列出运行和每个子 agent 的状态、用时、token、结果、transcript，可以跳过单个 agent 或停止运行；通知消息显示为一行。通用设置在 Settings → Plugins → paseo-dynamic-workflow → Dynamic workflows。

关闭后不再公布工具描述，并立即拒绝新的 workflow 启动；已经运行的任务继续执行，仍可查看、停止和接收结果。旧版已运行的 MCP shim 需要 Reload 才会加载新逻辑；已经写进旧会话的系统提示或历史消息不会被改写，需要完全干净的上下文时新建 agent。workflow 子 agent 不继承开启状态。

## 和 Claude Code 的差别

| | Claude Code `Workflow` | 本插件 |
| --- | --- | --- |
| 子 agent | Claude Code 进程内的 subagent | 真实的 Paseo agent，任意 provider；发起者的 subagent，跑完 archive |
| `opts.model` | Claude 模型别名 | 当前 provider 的模型 id/别名，或 `provider/model` 跨 provider |
| `opts.agentType` | Claude 子 agent 类型 | Paseo agent profile（名字或 id），或内置 `general-purpose`/`explore`/`plan`/`verification` |
| 额外选项 | | `provider`、`cwd` |
| `opts.schema` | StructuredOutput 工具 | 最终消息里的 JSON，Ajv 校验，不符合时追问最多 3 次 |
| `budget` | 本轮主循环 + 所有 workflow 的 output token | 本次运行子 agent 的 output token（取自 provider 上报，Codex/Pi 偏低） |
| resume | 未改动的最长前缀命中缓存 | 同样只复用最长未改动前缀：第一个新增、改动、重排或失败的调用及其后全部重跑；按调用顺序匹配，忽略完成顺序；被停止切断的调用重跑但不终止复用；label/phase 不参与 |
| 单次组合器条目上限 | 4096 | 4096；整次运行最多 4096 个运行时请求，最多启动 1000 个真实子 agent |
| 内置角色 | 子 agent 类型定义 | explore/plan/verification 是提示词，不强制只读；子 agent 保留父会话的权限约束，无法保守映射时拒绝创建 |
| 并发 | min(16, CPU-2) | 默认 min(8, CPU-2)，可设到 16（每个子 agent 是一个完整的 CLI 进程） |
| Ultracode | effort 档位，每轮 system reminder | 每个 agent 一个开关；写在 MCP instructions/工具描述，并在 reference、启动结果、通知里重申 |
| 规模建议 | /config 里的 Dynamic workflow size（默认 medium） | 插件设置，默认 unrestricted |
| 内置 workflow | deep-research | deep-review、deep-research、design-panel、critique、verify-claims（自己实现，未复制 Claude Code 的脚本） |
| 脚本全局量 | | 额外的 `guidance`（`{ ultracode, size }`）和 `agent()` 的 `timeoutMinutes` |

## 结构

```text
index.server.ts / server/contribute.ts   挂 hook、RPC、启动 bridge
server/agent-setup.ts                    agent.create 注入默认空 MCP 端点；清理继承配置；session_open 绑定 nonce→agent
server/agent-access.ts                   持久化每个 agent 的开启和 Ultracode 状态（agent-access.json 仍是 version 1）
server/workflow-catalog.ts               保存的和内置的命名 workflow：查找、列表、reference 末尾的目录
workflows/                               内置 workflow 源码；_shared.js 由 scripts/inject-shared.mjs 插入每个脚本
server/scripts.ts                        写 bin/ 下的 shell shim 和 lib/ 下的 mcp.mjs、cli.mjs（只用 Node 内置模块）
server/bridge.ts                         unix socket 上的 HTTP：/v1/tools/<name>
server/service.ts                        launch/stop/status/list、保存的 workflow、预算、卡片、通知、启动恢复
server/script-parse.ts                   acorn 解析 meta、确定性检查
server/worker-source.ts                  worker thread + node:vm 里的运行时（agent/parallel/pipeline/...）
server/engine.ts                         一次运行：worker、并发、缓存、上限、停止/跳过、卡死检测、journal
server/agent-runner.ts                   用 Paseo SDK 建子 agent、等待、结构化输出、worktree、archive
server/run-store.ts                      runs/<id>/{run.json,journal.jsonl,script.js,result.json}、resume 缓存
server/notifier.ts                       outbox：发起者空闲时投递通知
client/                                  卡片、通知行、面板、设置页
shared/                                  RPC 契约、运行快照 schema、设置、通知解析
docs/REFERENCE.md                        编写参考（scripts/build-reference.mjs 生成 server/reference.ts）
```

状态目录 `~/.paseo/paseo-dynamic-workflow/`（随 `PASEO_HOME`）：`bin/`、`lib/`、`bridge.sock`、`bindings.json`、`agent-access.json`、`guidance.json`、`outbox.json`、`runs/`、`workflows/`（内置 workflow 副本）、`REFERENCE.md`。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build:reference   # 改了 docs/REFERENCE.md 或 workflows/*.js 之后
paseo plugin reload paseo-dynamic-workflow
```

验证方式和记录见 [PROGRESS.md](PROGRESS.md)，截图在 `docs/verification/`。

预算以 provider 上报的 token 为准，不能保证实际花费的硬上限；已运行的 agent 也可能超出目标。resume 默认继承原 args，按名称启动会返回可独立编辑的脚本副本。Paseo 0.12 在中途 reload 后，若 bridge 提示未连接，打开一次 Dynamic workflows 面板即可恢复。历史运行保留用于 resume，没有自动清理策略。

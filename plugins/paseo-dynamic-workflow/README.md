# paseo-dynamic-workflow

把 Claude Code 的动态 workflow（`Workflow` 工具）带给 Paseo 里的任意 agent。agent 写一段 JavaScript 编排脚本，插件在 daemon 上后台执行；脚本里每个 `agent()` 都是一个真实的 Paseo 子 agent（任意 provider），结果回到脚本，整个运行结束后以 `<task-notification>` 消息投回发起的 agent。

脚本 API 和 Claude Code 一致：`agent(prompt, opts)`、`parallel(thunks)`、`pipeline(items, ...stages)`、`phase()`、`log()`、`args`、`budget`、`workflow(nameOrRef, args)`，`meta` 必须是纯字面量，`Date.now()`/`Math.random()`/无参 `new Date()` 不可用，`resumeFromRunId` 复用未改动的 `agent()` 结果。完整参考见 [docs/REFERENCE.md](docs/REFERENCE.md)（agent 通过 `workflow_reference` 工具读到的就是这份）。

## 安装

需要 Paseo 0.12 或更新（daemon 和 App）。在 daemon 主机上：

```bash
cd plugins/paseo-dynamic-workflow && npm ci
paseo plugin install "$PWD"
# 合并到 main 之后也可以从 Git 安装（manifest 里的 build 会执行 npm ci --omit=dev）：
paseo plugin install 'git:https://github.com/CM-BF/open-paseo-plugins.git:plugins/paseo-dynamic-workflow'
```

安装之后新建的 agent 才有工具；之前的 agent 不变。

## 用法

对 agent 说“用 workflow 做……”（必须是用户明确要求，工具描述里写了这条规则）。agent 会先调 `workflow_reference` 读参考，再调 `workflow` 启动；工具立即返回 run id、脚本路径和运行目录，agent 结束这一轮，等通知到来。

- Claude / Codex / OpenCode：MCP 工具 `workflow`、`workflow_status`、`workflow_stop`、`workflow_reference`（Claude 里显示为 `mcp__dynamic_workflow__*`）。
- Pi / OMP（不支持 MCP，读系统提示）：`~/.paseo/paseo-dynamic-workflow/bin/paseo-workflow run --file x.js | --name <saved> [--args-json ...] [--resume <runId>]`、`status`、`stop`、`reference`。调用者由 Paseo 设给 agent 进程的 `PASEO_AGENT_ID` 识别。
- 保存的 workflow：项目里的 `.paseo/workflows/<name>.js` 或 `.claude/workflows/<name>.js`（Claude Code 的保存 workflow 可以直接用），以及 `~/.paseo/workflows/`、`~/.claude/workflows/`。

界面：发起 agent 的聊天里有运行卡片（阶段进度、运行中的 agent、最新日志、结果、Stop/Details）；Dynamic workflows 面板（卡片 Details、`/dynamic-workflows`、Command Center 的 Show dynamic workflow runs）列出运行和每个子 agent 的状态、用时、token、结果、transcript，可以跳过单个 agent 或停止运行；通知消息显示为一行。设置在 Settings → Plugins → paseo-dynamic-workflow → Dynamic workflows。

## 和 Claude Code 的差别

| | Claude Code `Workflow` | 本插件 |
| --- | --- | --- |
| 子 agent | Claude Code 进程内的 subagent | 真实的 Paseo agent，任意 provider；发起者的 subagent，跑完 archive |
| `opts.model` | Claude 模型别名 | 当前 provider 的模型 id/别名，或 `provider/model` 跨 provider |
| `opts.agentType` | Claude 子 agent 类型 | Paseo agent profile（名字或 id），或内置 `general-purpose`/`explore`/`plan`/`verification` |
| 额外选项 | | `provider`、`cwd` |
| `opts.schema` | StructuredOutput 工具 | 最终消息里的 JSON，Ajv 校验，不符合时追问最多 3 次 |
| `budget` | 本轮主循环 + 所有 workflow 的 output token | 本次运行子 agent 的 output token（取自 provider 上报，Codex/Pi 偏低） |
| resume | 未改动的最长前缀命中缓存 | 按 (prompt, 影响结果的 opts) 内容匹配，和调度顺序无关；label/phase 不参与 |
| 并发 | min(16, CPU-2) | 默认 min(8, CPU-2)，可设到 16（每个子 agent 是一个完整的 CLI 进程） |

## 结构

```text
index.server.ts / server/contribute.ts   挂 hook、RPC、启动 bridge
server/agent-setup.ts                    agent.create 注入 MCP 服务器、系统提示、预授权；session_open 绑定 nonce→agent
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

状态目录 `~/.paseo/paseo-dynamic-workflow/`（随 `PASEO_HOME`）：`bin/`、`lib/`、`bridge.sock`、`bindings.json`、`outbox.json`、`runs/`、`REFERENCE.md`。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build:reference   # 改了 docs/REFERENCE.md 之后
paseo plugin reload paseo-dynamic-workflow
```

验证方式和记录见 [PROGRESS.md](PROGRESS.md)，截图在 `docs/verification/`。

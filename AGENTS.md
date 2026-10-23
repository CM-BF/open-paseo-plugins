# open-paseo-plugins：插件开发与测试原则

每个插件一个目录 `plugins/<id>/`（含 `paseo-plugin.json`）。下面的原则适用于本仓库的所有插件，也适用于在本机测试的其他 Paseo 插件（例如 Flowly fork）。

`paseo` 不一定在 agent shell 的 PATH 里；macOS 桌面版的 CLI 在 `/Applications/Paseo.app/Contents/Resources/bin/paseo`。

## 目录规范

- 本仓库的所有插件都必须放在 `plugins/<id>/`，每个插件独占一个目录。禁止把插件放在仓库根目录或其他顶级目录。
- 插件的 `paseo-plugin.json`、入口、源码、依赖声明、文档和测试资源均放在该插件目录内。新增、导入或迁移插件时，同步更新 README、安装路径和相关引用。

## 进度记录

1. 每个插件在自己的目录里维护 `PROGRESS.md`：目标、关键设计决定（以及为什么）、子任务清单和各自状态、验证记录（日期、daemon 版本、commit、场景、结果、截图路径）、已知问题和下一步。
2. 开工前先读它；每完成一个子任务就更新它，和代码一起提交。中断后接手的 agent 只读 `PROGRESS.md` 和 git log 就能继续，不依赖对话记录。
3. 状态要如实：只写已经验证过的结论。没跑通、没验证、被跳过的项写明原因，不标成完成。

## 测试：直接装到我们的 daemon 上

1. 测试对象就是本机正在运行的 Paseo daemon（主 daemon）。先用 `paseo daemon status --json` 记下 home（`~/.paseo`）、listen（`127.0.0.1:6767`）、`serverId` 和 `daemonVersion`。不另起临时 daemon，不换 `--home`，不用 mock host 代替。
2. 先跑 typecheck 和单测，通过后再安装：`paseo plugin install <插件目录的绝对路径> --id <id>`。之后每次改动用 `paseo plugin reload <id>`，不重启 daemon：它同时在服务其他 agent 和用户自己的会话。
3. 安装或 reload 后核对：`paseo plugin ls <id> --json` 的 `status` 是 `running`，`path` 是刚测试的目录；`paseo plugin logs <id>` 没有启动错误。`running` 只说明插件加载了，不说明功能可用。
4. 替换一个已安装的插件之前，先记下它原来的来源（`paseo plugin ls <id> --json` 里的 source、remote、revision 或目录），并备份 `~/.paseo/plugin-data/<id>/`。交付时写明 daemon 现在装的是哪个来源，以及怎样恢复原来的来源。
5. 不要让 daemon 长期指向会被删除的临时 worktree。worktree 清理后插件会变成 `failed`：`kanban` 就曾指向已删除的 `…/hermes-kanban-paseo-open-91ba/open-paseo-plugins/plugins/kanban`，报 `Plugin manifest is missing`。测试结束后要么切回稳定的 checkout 或原来源，要么在交付说明里明确告诉用户当前指向的是临时路径。
6. 不改动、不重装、不禁用与本次任务无关的插件。配置里失效的条目只报告，不擅自删除。

## 验证：用 Web UI

1. 功能验收以真实 Web UI 为准：用 Paseo 内置浏览器（`browser_new_tab`、`browser_snapshot`、`browser_click`、`browser_screenshot` 等工具）或本机 headless Chrome 打开 `https://app.paseo.sh`。它经 daemon 的 CORS 白名单直连 `127.0.0.1:6767`。daemon 自己的 `http://127.0.0.1:6767/` 不提供页面（`features.webUi` 未开启，返回 404），不要为了测试去开启它或改 daemon 配置。
2. 截图前确认两件事：页面连的是本机 daemon（侧栏和设置里的 host 名、server ID 与 `paseo daemon status` 一致）；加载的是刚 reload 的版本（能看到这次新增的文案、按钮或版本号）。
3. 按用户的实际路径操作：从侧栏入口进入插件，点按钮、填表单、看状态变化。涉及持久化的，刷新页面后再确认一次。桌面宽度和窄宽度（compact）布局都要看。
4. 每个验收场景保存截图，存到插件仓库的 `docs/verification/` 或 `$HOME` 下的持久路径，并记录 daemon 版本、插件路径和 commit、fixture ID、场景、结果，以及没有验证到的部分。截图里不能有凭据或无关的私人对话。不得用生成的图片、伪造的页面或 mock 结果冒充真实运行截图；环境阻止 UI 验证时如实说明，不宣称已通过。
5. typecheck、单测和 `plugin ls` 的 `running` 都只是前置检查，不能代替 Web UI 验证。
6. 截图流程：`browser_new_tab` 打开 `https://app.paseo.sh` → `browser_snapshot` 找到入口 → 操作 → `browser_screenshot` 保存。截图前用 `browser_resize` 切换桌面宽度（如 1440×900）和窄宽度（如 420×860）各截一张。截图文件名写清场景，如 `docs/verification/2026-10-22-card-running-desktop.png`，并在 `PROGRESS.md` 的验证记录里引用。
7. Paseo 内置浏览器的标签页在后台打开，可能一直不绘制（`browser_screenshot` 报 `screenshot_no_frame`）。这时用本机 headless Chrome 截图：按 `scripts/cdp.mjs` 文件头的参数启动（必须带 `--disable-features=LocalNetworkAccessChecks`，否则 `https://app.paseo.sh` 连不上 `localhost:6767`，WebSocket 报 1006），第一次在欢迎页选 Direct connection，Host 填 `localhost`。用 `node scripts/cdp.mjs window 1440 900` / `window 420 860` 切换桌面和窄宽度（`size` 的设备模拟只在一次调用里有效），`goto`、`click-text`、`shot` 操作和保存截图。用完关掉 Chrome，删除它的 `--user-data-dir`。
8. 会给 agent 加工具或往 agent 时间线写内容的插件（MCP 注入、timeline row、通知回投），要用插件安装之后新建的测试 agent 走一遍真实流程：让 agent 调用工具，在 Web UI 里看到工具调用、插件卡片和回投的消息。插件安装之前就存在的 agent 拿不到新注入的工具。

## 测试数据与资源

1. 用专门的 fixture：临时目录、测试用的 project、workspace、session，名称带明显标记（如 `plugin-test-<日期>`）。创建前记下 ID 和路径，结束后清理，并在原生 Paseo 和插件界面里各确认一次已清理。不动用户的真实项目、卡片和会话。
2. 会启动 agent 的测试用最便宜的可用模型，测完 stop 并 archive 测试 session。
3. 日志、截图和报告里不出现 token、凭据或与本次无关的用户配置。

## 提交

- 在 `sw/` 分支上工作，每完成一个子任务就提交一次；只提交本次任务的改动。

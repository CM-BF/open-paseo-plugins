# open-paseo-plugins：插件开发与测试原则

每个插件一个目录 `plugins/<id>/`（含 `paseo-plugin.json`）。下面的原则适用于本仓库的所有插件，也适用于在本机测试的其他 Paseo 插件（例如 Flowly fork）。

`paseo` 不一定在 agent shell 的 PATH 里；macOS 桌面版的 CLI 在 `/Applications/Paseo.app/Contents/Resources/bin/paseo`。

## 测试：直接装到我们的 daemon 上

1. 测试对象就是本机正在运行的 Paseo daemon。先用 `paseo daemon status --json` 记下 home（`~/.paseo`）、listen（`127.0.0.1:6767`）、`serverId` 和 `daemonVersion`。不另起临时 daemon，不换 `--home`，不用 mock host 代替。
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

## 测试数据与资源

1. 用专门的 fixture：临时目录、测试用的 project、workspace、session，名称带明显标记（如 `plugin-test-<日期>`）。创建前记下 ID 和路径，结束后清理，并在原生 Paseo 和插件界面里各确认一次已清理。不动用户的真实项目、卡片和会话。
2. 会启动 agent 的测试用最便宜的可用模型，测完 stop 并 archive 测试 session。
3. 日志、截图和报告里不出现 token、凭据或与本次无关的用户配置。

## 提交

- 在 `sw/` 分支上工作，每完成一个子任务就提交一次；只提交本次任务的改动。

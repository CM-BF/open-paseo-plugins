# 自由后端与原生评论收件箱

用户于 2026-11-08 明确要求开始实现。开发基于本机已验收的 `31c4a271`，保留组合 Board、pill 与企业 GitHub 发布；新能力不自动合并 main。

## 产品边界

agent 编写普通应用代码：HTTP 路由、业务逻辑、表结构、查询与迁移都属于应用项目。脚手架提供可编辑的 Node/SQLite 起点、初始化、运行、SSH 部署、迁移、备份和恢复，不以投票或预设 CRUD 目录限制产品。

浏览器通过 HTTP(S) 连接应用；SSH 是部署与维护通道。默认只监听本机，公开或企业内部访问使用目标已有反向代理及认证。Pages 可以使用明确配置的 API 地址；不把管理凭据放入 public 配置或导出 HTML。

发布时固定 `apiOrigins` 列表；导出画布通过通用 `board.request` 调用这些后端。请求由发布页外层执行，以保留真实 CORS 来源，作者画布继续隔离。API 权限不开放外部脚本，且不带 Cookie 或主机凭据。预览不发后端请求；真实联调使用 HTTP(S) 托管的导出页。详细用法见 published-apps.md。

评论属于独立的 Board 原生收件箱。接收访客评论不创建 Board 的 User intent，也不会唤醒负责这张 Board 的 agent。用户控制两个默认关闭的权限：读取、内部 triage。triage 只修改分类、状态和内部备注，不能公开回复或修改应用。2026-11-13 起另有一个需要单独确认的「Agent 自动处理并公开回复」：开启后新评论只交给这张 Board 专用的评论助手，由它用 `board_inbox_reply` 回复访客（见[发布页访客评论](page-comments.md)）。2026-11-14 起评论助手不再是 Paseo agent，而是插件为每批评论启动的封闭 `claude -p` 进程：只有四个评论工具，不加载用户设置、其他插件和 CLAUDE.md，每次启动先做锁定检查（见[评论收件箱](comment-inbox.md)）。修改应用仍需要具体授权。

## 模块与协议

- `backend/` 和 `scripts/board-app.mjs`：生成普通应用项目，执行其本机生命周期；SSH 使用用户已有配置，严格核验主机密钥、远端归属和精确部署计划。应用 release 与持久数据分开，拒绝覆盖已有未知目录。
- 后端保留独立的评论入口与只读导出入口。可选公开 POST 创建评论；带专用 Bearer token 的 GET 按 cursor 导出。deploymentId 在持久数据里生成一次。来源身份随应用数据保存，不随代码部署改变。
- `server/inbox-store.ts`：独立原子持久账本，绑定 Board 创建身份与来源 deploymentId，原样保存有界访客文本、去重、分页和审计。相同外部 ID 不允许悄悄改变原内容。
- `server/inbox-sync.ts`：用户登记端点与私有凭据；`server/inbox-auto.ts` 自动同步（约 5 秒一次，可暂停，保留「立即同步」）；固定端点、禁止重定向、限制响应大小，认证失败不推进游标。回复由插件用主机上的令牌发到后端。凭据不返回给 agent、画布或页面。
- Board UI：用户查看收件箱、登记来源、同步、设置读取和 triage 权限、内部处理。通过现有 host-bound RPC 接入，不修改 Paseo 客户端。
- agent CLI/MCP：list/read/triage 三种操作，以及只有评论助手（封闭运行，凭只在内存里的运行令牌）能用的 reply，必须有原生 agent binding 或检查通过的运行令牌；工具不存在 policy/source/sync 入口，负责人和 Side 调用 reply 会被拒绝。每次操作重新核验当前授权，撤销后拒绝继续读取或修改。

单页评论协议为 `{deploymentId,cursor,nextCursor,comments}`。单条包含 `externalId,text,createdAt`，可选 `authorName,pageUrl,anchor`；作者名为自报身份。首次 cursor 使用 `"0"`，Board 内来源 checkpoint 同样从 `"0"` 开始。评论始终标为 external-untrusted。

## 可核验的完成条件

1. 生成项目、agent 改写自定义接口/存储逻辑、写入后重启读回。
2. 迁移事务与校验、在线一致性备份、显式停服务后恢复，失败保留数据。
3. SSH 精确计划、安全传参、归属检查、版本切换及失败处理。未指定真实服务器时只能声称本地或隔离 SSH 验证。
4. 原生收件箱的身份隔离、去重、游标、并发、权限拒绝/撤销及 triage 审计。
5. 真实 MCP SDK 发现新工具，未授权 agent 无法读取访客内容；读取和 triage 没有自动消息、改应用或公开回复副作用（自动处理另需确认，只唤醒评论助手）。
6. Board UI、原有发布/组合/评论回归、构建产物和实际 Helper 验收之后才能安装。

远端服务器尚未指定。自动改应用尚未实现，不能用 triage 权限替代。状态由新 Board「Board · 能力与开发进度」持续记录。

## 2026-11-13 状态：发布页访客评论

发布页访客可以框选文字评论，后端保存访客线程和作者回复，插件自动同步，确认后由专用评论助手回复。三部分在集成分支 `sw/board-page-comments` 合并，`npm run test:page-comments` 在本机回环地址上跑通完整流程（真实后端、另一个来源上的导出页面、Chromium、插件自动同步、封闭运行的评论助手经插件自己的 MCP 工具回复、访客页面看到回复）。尚未安装到 daemon，也未在真实 GitHub Pages 与用户部署的后端上验收。使用说明见[发布页访客评论](page-comments.md)。

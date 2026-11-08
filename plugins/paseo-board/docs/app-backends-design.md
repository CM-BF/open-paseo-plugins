# 自由后端与原生评论收件箱

用户于 2026-11-08 明确要求开始实现。开发基于本机已验收的 `31c4a271`，保留组合 Board、pill 与企业 GitHub 发布；新能力不自动合并 main。

## 产品边界

agent 编写普通应用代码：HTTP 路由、业务逻辑、表结构、查询与迁移都属于应用项目。脚手架提供可编辑的 Node/SQLite 起点、初始化、运行、SSH 部署、迁移、备份和恢复，不以投票或预设 CRUD 目录限制产品。

浏览器通过 HTTP(S) 连接应用；SSH 是部署与维护通道。默认只监听本机，公开或企业内部访问使用目标已有反向代理及认证。Pages 可以使用明确配置的 API 地址；不把管理凭据放入 public 配置或导出 HTML。

评论属于独立的 Board 原生收件箱。接收访客评论不创建 Board 的 User intent，不自动唤醒 agent。用户控制两个默认关闭的权限：读取、内部 triage。triage 只修改分类、状态和内部备注，不能公开回复或修改应用。后两者仍需要具体授权。

## 模块与协议

- `backend/` 和 `scripts/board-app.mjs`：生成普通应用项目，执行其本机生命周期；SSH 使用用户已有配置，严格核验主机密钥、远端归属和精确部署计划。应用 release 与持久数据分开，拒绝覆盖已有未知目录。
- 后端保留独立的评论入口与只读导出入口。可选公开 POST 创建评论；带专用 Bearer token 的 GET 按 cursor 导出。deploymentId 在持久数据里生成一次。来源身份随应用数据保存，不随代码部署改变。
- `server/inbox-store.ts`：独立原子持久账本，绑定 Board 创建身份与来源 deploymentId，原样保存有界访客文本、去重、分页和审计。相同外部 ID 不允许悄悄改变原内容。
- `server/inbox-sync.ts`：用户登记端点与私有凭据，人工同步一页；固定端点、禁止重定向、限制响应大小，认证失败不推进游标。凭据不返回给 agent、画布或页面。
- Board UI：用户查看收件箱、登记来源、同步、设置读取和 triage 权限、内部处理。通过现有 host-bound RPC 接入，不修改 Paseo 客户端。
- agent CLI/MCP：只增加 list/read/triage 三种操作，必须有原生 agent binding；工具不存在 policy/source/sync 或公开回复入口。每次操作重新核验当前授权，撤销后拒绝继续读取或修改。

单页评论协议为 `{deploymentId,cursor,nextCursor,comments}`。单条包含 `externalId,text,createdAt`，可选 `authorName,pageUrl,anchor`；作者名为自报身份。首次 cursor 使用 `"0"`，Board 内来源 checkpoint 同样从 `"0"` 开始。评论始终标为 external-untrusted。

## 可核验的完成条件

1. 生成项目、agent 改写自定义接口/存储逻辑、写入后重启读回。
2. 迁移事务与校验、在线一致性备份、显式停服务后恢复，失败保留数据。
3. SSH 精确计划、安全传参、归属检查、版本切换及失败处理。未指定真实服务器时只能声称本地或隔离 SSH 验证。
4. 原生收件箱的身份隔离、去重、游标、并发、权限拒绝/撤销及 triage 审计。
5. 真实 MCP SDK 发现新工具，未授权 agent 无法读取访客内容；无自动消息、改应用或公开回复副作用。
6. Board UI、原有发布/组合/评论回归、构建产物和实际 Helper 验收之后才能安装。

远端服务器尚未指定。公开回复与自动改应用尚未实现，不能用 triage 权限替代。状态由新 Board「Board · 能力与开发进度」持续记录。

# Board 原生评论收件箱

评论收件箱保存部署后网页访客的留言，供人阅读，并在用户授权后供 Board 的 owner 或已验证的 fork 读取、内部分类。它独立于会话消息和 Board 修改请求；导入、读取和 triage 都不会创建 interaction、唤醒 agent 或发送消息。

## 权限

- 新 Board 实体的 `read`、`triage` 都为 `false`。人可以在收件箱里单独开放读取和内部处理；内部处理必须先允许读取。
- 只有服务端确认的人类 RPC 可以改权限、登记来源、轮换凭据、禁用来源或手动同步。agent 工具没有这些操作，不能自行授权。
- agent 读取或 triage 时同时检查当前 Board 实体、owner/fork 身份和当前 policy；已撤销权限同样会阻止旧请求的幂等重放。
- triage 仅含 `new` / `reviewing` / `resolved` / `dismissed`、最多 12 个标签和内部备注。它不能改原始评论、页面代码、应用数据，也不能给访客回复。修改应用与公开回复需要另外的明确授权与接口，本收件箱不授予它们。
- 外部文字以文本呈现，返回结果逐条标注 `contentTrust: "external-untrusted"`，并包含固定的外部输入提示。评论、作者名、页面 URL 和选择器都不作为指令执行。

## 来源与导入协议

`InboxStore` 只在插件服务端的单一 coordinator 实例运行，存储目录为插件 dataDir 下的 `inbox/`。不得让多个进程同时写同一目录。实例间在同一进程内共享按文件串行队列。

所有调用必须传 `boardId` 和从权威 Board 读取的 `expectedCreatedAt`。每次调用重新核对实体，写入前再次核对。存储文件名包含此完整身份的摘要；删除后重建的同 ID Board 不会继承旧评论或授权。

每个来源由人类登记 `sourceId`、`deploymentId`、显示名称和至少 32 字符的随机凭据。凭据只在传入时短暂使用，收件箱只保存 SHA-256 摘要；列表、读取、审计与收件箱回复均不返回凭据或摘要。由 connector 持有的原始凭据必须另存为仅当前用户可读的文件，不能注入画布、导出网页或 agent 提示。

`sourceId` 一经使用就固定绑定一个 deployment。新部署必须使用新的来源 ID，不能把旧来源偷换为同名新实例。相同来源允许轮换凭据或禁用，但保留已提交游标和原始评论。

后端页格式：

```json
{
  "deploymentId": "deployment-identity",
  "cursor": "0",
  "nextCursor": "24",
  "comments": [{
    "externalId": "comment-24",
    "text": "这一段的解释可以更清楚。",
    "authorName": "访客",
    "createdAt": "2026-11-08T20:00:00.000Z",
    "pageUrl": "https://internal.example/app/",
    "anchor": { "label": "结果", "selector": "#result" }
  }]
}
```

`authorName`、`pageUrl`、`anchor` 可省略；时间使用 UTC ISO。页面 URL 允许 HTTP 和 HTTPS，便于内网或本地部署；UI 不会自动打开它。每来源起始游标为字符串 `"0"`。导入必须匹配当前游标，包含新评论时必须推进游标。

导入模块还接收当前收件箱 `expectedRevision`、唯一 `eventId` 和服务端构造的 ingress actor（精确 source/deployment/credential）。验证凭据、加入评论、游标推进和审计回执在同一次原子文件替换内提交；网络丢失响应后，完全相同的事件可重放并返回 `replayed:true`、原始 `committedRevision` 与当前 `revision`。改变事件内容会拒绝。撤销来源或轮换旧凭据后，旧凭据不能借重放继续访问。

按 `sourceId + externalId` 去重。重叠页中的完全相同评论计为 duplicate；同一个外部 ID 的内容改变会拒绝整页，保存此前原始证据，绝不悄悄覆盖。失败时不保存前缀，也不推进游标。不同来源的同一 externalId 是不同评论。

## 存储、并发与限制

收件箱为独立、有界的 JSON ledger。临时文件使用 `0600`，写入和 fsync 后 rename，再同步目录；拒绝符号链接、不规则文件和损坏 ledger，不自动重建或清空它。服务端同一进程中的各实例按路径串行，修改还要求收件箱 revision，triage 额外要求评论 revision。

上限：32 个来源、5,000 条评论；每页最多 100 条和 100,000 个序列化字符；正文每条 8,000 字符、作者名 160、页面 URL 2,000、内部备注 4,000。总文件最多 32 MB，审计最多 20,000 个事件。达到普通写入上限时拒绝本次操作，保留全部已有评论和回执。末尾预留 34 条审计和 128 KB，仅供撤销 32 个来源与两项 agent 权限，避免写满后不能撤权。此版本不自动删历史；后续可提供明确的归档/新分片流程。

列表按提交顺序返回，默认每页 30、最多 100；分页游标包含收件箱 revision。后续页遇并发修改时要求重新加载，避免漏读或混合不同快照。最近 30 条审计随列表返回，完整审计保存在 ledger，记录权限、来源、导入与内部处理的主体、事件 ID、时间和 revision；只读调用不写审计以免把读取变成无限写入。

## 接入接口

`shared/inbox.ts` 导出所有 Zod schema、类型与人类 RPC 合约：`board.inbox.list`、`read`、`policy`、`source`、`triage`。导入不注册为通用 RPC，而由服务器上的 connector 同步流程调用 `InboxStore.importPage`。actor 必须由服务端构造，不能取自 agent 或网页提供的字段。

构造函数要求 `resolveBoard` 权威实体查询，可选 `authorizeAgent` 只供验证 owner 之外的合法 fork；缺省拒绝所有非 owner agent。`client/inbox-panel.tsx` 是通过实际 `onList` / `onPolicy` / `onTriage` 回调工作的主题化纯组件；未接上服务不能冒充可用。

本模块测试验证存储、授权、身份隔离、导入重试、并发与分页边界。安装后真实 daemon、完整 connector 拉取以及页面操作的验收由整合记录报告，单元测试不代替这些验收。

2026-11-08：`node node_modules/vitest/vitest.mjs run server/inbox-store.test.ts` 通过 14 项测试，包括总量达到 5,000 条后的原子拒绝，以及审计满额后的撤权保留空间。此时收件箱模块与面板的 TypeScript 检查无错误；整合树另一个连接器文件的类型问题正在主任务中处理。本记录不代表安装或真实页面验收已完成。

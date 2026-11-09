# 自由后端、发布 API 与原生评论收件箱验收

2026-11-08，本轮固定运行源码为 `4b5d226808d5eff6f33a7538753821cbe0ed51fd`。干净源码、浏览器组件、隔离真实 SSH、生产 Helper 和安装后的新 native agent 功能验收通过。主 daemon 的真实界面验收仍未完成，本文不将组件截图或服务端读回当作真实 UI 证据。

## 交付行为

- `paseo-board-app` 初始化普通 Node/SQLite 应用。Agent 自由修改路由、业务逻辑、存储接口、SQL 迁移和前端；脚手架提供运行、停止、状态、事务迁移、一致性备份、明确恢复，以及绑定精确计划的 SSH 部署和维护。示例路由可以替换。部署源码与持久数据分开。
- 发布面板允许指定后端 API origin，并随发布快照固定。作者通过通用 `board.request` 调用应用接口；外层发布页提供真实网站 CORS origin，作者画布保留沙箱，主机凭据不会注入请求。
- “更多 → 评论收件箱”允许人登记私有导出来源、手动同步一页、查看留言和内部处理。读取与 triage 授权默认关闭；访客文字明确标记为不可信外部数据，不会自动变成用户指令或唤醒 agent。内部处理只改状态、标签和备注，不授予应用修改或公开回复权限。
- Enter 暂存评论；Option/Alt+Enter 仅把当前评论发给所选 Side；Option/Alt+Shift+Enter 强制新 Side；Cmd/Ctrl+Enter 将当前评论和已有队列合为一次主会话投递。Shift+Enter、IME、持键防重复、存储失败保留和未知结果原路重试保持可用。已有讨论追问仍保留原线程；独立队列非空时先明确提示处理队列，不静默拆分投递或丢线程。

本轮仅修改 Board 插件，保留嵌套画板、Board pill、公司 GitHub 发布等现有能力。后端接口、数据库与界面不是预设投票产品。使用方式见[后端脚手架](../app-backend-scaffold.md)、[发布 API](../published-apps.md)和[收件箱权限](../comment-inbox.md)。

## 干净源码与隔离验收

外部私有证据的公共前缀为 `$PASEO_HOME/verification/paseo-board/app-backends-20261108/`，下文路径相对该目录。回执保留精确源码、命令、日志和文件摘要；无需把全部摘要复制到公开文档。

| 范围 | 结果及边界 | 主要证据 |
| --- | --- | --- |
| 固定源码 | TypeScript 和全部 612 项源码测试通过。10 项 inbox-sync 单独单 worker，其余 602 项最多 4 workers；原 5 秒单项超时与所有断言未改。 | `integrated-1794180355669670000/receipt.json` |
| 后端运行 | 开发 Node 和真实 Paseo Helper 各 16 项检查通过，包含 HTTP/SQLite、迁移失败回滚、WAL 备份/恢复、评论幂等与恢复游标、访客表单、sh/zsh/fish 的实际命令解析、隔离目录中的部署控制。 | 同目录 `backend-node.log`、`backend-helper.log` |
| 浏览器组件 | 收件箱 7 项、批量评论/快捷键 13 项、草稿 14 项、既有宿主 38 项、位置恢复 9 项、组合宿主 12 项、完整画布 118 项通过。覆盖权限、失败恢复、未知结果协调、420px 可达和原画布状态保留；Paseo 传输由 fixture 适配。 | 同目录各 scope 日志 |
| 发布与 API | 发布宿主 17 项、静态发布浏览器 13 项通过。真实双 HTTP origin 验证写入/读取、刷新持久数据、非 null Origin、Cookie 隔离、未授权 origin/重定向/超限拒绝，以及预览零 API 流量。宿主 GitHub/Paseo 传输为适配测试，未向 GitHub 发布。 | 同目录 `release-host.log`、`release-browser.log` |
| 三产物与生产装包 | App runtime、store worker、客户端重新构建并核对固定资产；Hermes 通过。实际 Helper 编译和双 worker IPC、保存/读取/编辑、快照与 ZIP 导出、展开 runtime、带空格路径 launcher 初始化应用、默认 inbox 权限关闭和自有进程清理通过。 | 同目录 `production-packaging/receipt.json` |
| 真实 SSH | 本机独立 loopback sshd 的公钥握手、精确计划部署/健康检查、在线备份、本地源码编辑后的部署版本维护、保留数据/身份的再部署，以及日志/最终停止，共 6 项通过。该隔离应用和 sshd 已停止，临时私钥已移除。 | `ssh-protocol-native-2/receipt.json` |

SSH 证据执行于 `52c5a552c12679ba0b3a249fed3f3eb14bdd8eec`；整合回执核对其 7 个控制文件与最终源码相同后沿用，没有宣称重新执行。它证明本机真实 SSH 协议及账号登录 shell 路径，不证明公司服务器、跨网络、代理/SSO、TLS 或开机托管。未连接工作电脑。

## 本机安装与新 native agent

`install-app-backends-1794182861263-87e758.json` 记录在 Paseo 0.14.0 主 daemon 上备份并安装精确交付树，稳定目录为 `$PASEO_HOME/local-plugins/paseo-board/dev`。251 个跟踪文件逐字节匹配运行源码；原有 16 张 Board 的内容与版本全部保留。依赖未重装，安装器没有执行应用 CLI、迁移、恢复或 agent 发送。备份为 `$PASEO_HOME/backups/paseo-board-app-backends-1794182861263-87e758`。

只重载 Board 一次；插件运行正常，旧 Board worker 池退出，新池恰好两个子进程。主 daemon 和 daemon worker 的进程身份前后相同；没有重启 daemon、回滚数据或修改 main。安装成功仅证明安装与运行状态，后续功能证据单独记录。

安装后新建的专属 native agent 完成三轮实际工具调用，根代理复核了完整 timeline、工具结果及独立数据读回：

1. 默认权限关闭，读取被拒绝。
2. 人开放读取后，agent 能读到测试评论；triage 仍被拒绝。
3. 人单独开放 triage 后，agent 完成内部处理，并重新读取到精确状态、标签和备注。

正好发送了 3 条专属测试消息；完整 native timeline 中没有其他工具调用，没有文件、shell、编辑或部署操作。后端评论导出、测试 Board 画布及原有 16 张 Board 分别读回确认未变。测试前没有应用文件 hash 基线，因此**不能声称应用文件逐字节未变**；证据限于无相关工具调用和上述独立读回。

最终功能复核为 `actual-20261109T001023602Z-664a5e4b9e/functional-root-review.json`，状态为 `functional-passed-ui-pending`；三轮原始证据分别是该目录下 `native-denied.json`、`native-read-only.json`、`native-triage.json`。功能复核本身没有额外发送消息。权限配置与数据读回是实际服务路径，不是通过真实 UI 点击完成。

## 保留的失败与修正

首轮全套源码测试为 610/612，通过 4 workers 限制后为 611/612；剩余失败是最大 UTF-8 来源的磁盘密集容量恢复用例超过原 5 秒上限。未改源码的单项诊断在 2.937 秒完成断言，诊断使用 20 秒观察上限，不作整合通过证据。最终将整个 inbox-sync 文件隔离运行，其余文件限制并发，原 5 秒上限下全部 612 项通过。原日志和资源隔离理由保存在 `source-timeout-diagnosis.md`，未修改产品或弱化断言。

第一次安装门控将一条 11 月 1 日的静止旧发布 `unknown` 记录误认作在途发布，等待 30 分钟后退出，源码修改与重载均为零。核查确认该精确记录没有自动发布授权或在途字段，旧/新版调度器都不会推进它。修正仅允许该字节未变的记录不阻塞空闲判断，保留其 unknown 状态和原始字节，不重试、不协调远端状态、不访问 GitHub；其他门控不变。原失败为 `install-app-backends-1794180961880-2adc1d.json`，核查为 `install-preparation/dormant-publication-root-review.json`，之后才执行上述成功安装。

## 未完成项与使用边界

- 主 daemon 真实 UI 未验。CUA 在三个应用的窗口获取均返回 `cgWindowNotFound`，尚未取得所需宽/窄页面、刷新和原生工具详情截图；用户解锁问题待答。组件测试截图和 native timeline 不替代真实 UI。
- 本次主 daemon 的专属 fixture 已安全暂停：后端完成一致性备份并停服，agent 读取/triage 权限关闭、来源停用。评论和三轮历史保留供后续 UI 继续验证；**尚未删除或归档**。不要重复创建、发送三轮消息或把隔离 SSH 的已清理状态套到此 fixture。资源清单和接续依据在实际验收目录，下一步按 `actual-acceptance-plan.md` 完成 UI 后再清理。
- 评论由人明确同步导入，不自动唤醒 agent。读取和内部 triage 不授予改应用或公开回复；这些仍需单独授权和接口。
- 生产 HTTPS、DNS、公司认证和开机托管由目标基础设施提供；SSH 用于部署维护，访客通过 HTTP(S) 使用网页。CORS 不等于用户认证。
- 发布 API 仅访问随快照批准的 origin；不带 Cookie、不跟随重定向、不提供主机凭据。原生预览和磁盘文件没有可信 HTTP(S) origin，不能调用后端。应用需处理发布前状态、访客认证和提交幂等。
- 运行版本已安装；后续交付文档单独提交与同步，不代表重新执行运行时测试。草稿 PR 保留真实 UI 与 fixture 清理的未完成状态；main 未改。

首轮暂停在任何应用/权限操作前被全局插件数据一致性门控阻断；保留零动作失败记录。续办仅约束唯一测试资源，并单独记录无关数据的同期变化，不要求其他任务静止。

暂停回执：`actual-20261109T001023602Z-664a5e4b9e/pause-1794183733373-12b830/receipt.json`。暂停没有重载插件、重启 daemon 或发送消息。

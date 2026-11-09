# 自由后端、发布 API 与原生评论收件箱验收

2026-11-08，本轮固定运行源码为 `4b5d226808d5eff6f33a7538753821cbe0ed51fd`。干净源码、浏览器组件、隔离真实 SSH、生产 Helper、安装后的新 native agent 和主 daemon 实际界面验收通过。实际界面及最终只读收口时，252 个已安装跟踪文件精确匹配文档交付提交 `2063ca524cbb5a2914395de689a715b082cbc490`；运行源码未变。组件、原生工具和实际界面证据分别记录；专属 fixture 已于 2026-11-09 按精确账本清理。

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

第一阶段功能复核为 `actual-20261109T001023602Z-664a5e4b9e/functional-root-review.json`，保留当时的 `functional-passed-ui-pending` 状态；三轮原始证据分别是该目录下 `native-denied.json`、`native-read-only.json`、`native-triage.json`。这一阶段的权限配置与数据读回走实际服务路径，没有通过 UI 点击，也没有额外发送消息。后续 UI 证据如下，原阶段记录未被改写。

## 主 daemon 实际界面与最终只读核对

用户解锁后，CUA 操作真实 Chrome 中的脚手架访客表单，只提交一条新的专属评论。`app.paseo.sh` v0.15.3 的独立 direct TCP 连接以 1006 失败，随后使用已连接同一本机 Paseo 0.14.0 主 daemon 的原生 Paseo WebView 验证 Board；未修改 Paseo 客户端或浏览器安全设置。复用原后端部署、Board、agent 和三轮历史，没有新建或重发测试轮次。

| 实际路径 | 观察到的结果 |
| --- | --- |
| 访客表单 → 来源同步 | Chrome 显示提交成功；原生 Paseo 启用原来源后同步 `imported 1 / duplicates 0`。原评论与新评论同时可见，`<em>` 内容按普通文字显示。 |
| 读取和内部处理权限 | 初始读取/triage 关闭；UI 单独开启读取，再开启 triage。关闭收件箱后原画布的输入文字仍保留。 |
| Comment → Enter → 完整刷新 | 真实作者 Comment 按钮打开输入；普通 Enter 只暂存唯一评论，待发送为 1、讨论为 0。完整客户端刷新恢复相同文字；随后通过 UI 删除这条专属草稿。 |
| 420×860 收件箱 | 键盘聚焦滚动到第二条评论的内部处理编辑器、状态和取消控件。取消没有修改评论；随后通过 UI 撤回读取及 triage，并停用原来源。 |
| 原生 agent 历史 | 原三轮的读取/triage 工具详情和最终回复可见。展开结果显示原标记、不可信外部内容标识，以及已提交的内部处理结果；没有再次运行工具。 |

实际验收目录为 `actual-20261109T001023602Z-664a5e4b9e/`。根视觉复核 `ui-unlocked/root-ui-review.json` 绑定了 18 张原始截图，包括 `visitor-success.png`、`inbox-two-comments.png`、`policy-read-only.png`、`policy-triage-enabled.png`、`canvas-retained-after-inbox.png`、`enter-queued-before-refresh.png`、`enter-queued-after-refresh.png`、`queue-empty-after-delete.png`、`inbox-420-triage-editor.png`、`inbox-420-permissions-revoked.png`、`inbox-420-source-disabled.png` 和原生工具/最终回复截图。截图及其 hash 保存在私有证据目录，不提交访客内容、会话截图或凭据。

`readonly-final-1794207715566-a1ae2c.json` 于 `2026-11-09T07:01:56Z`（本地 11 月 8 日）完成只读收口，绑定上述视觉复核及全部截图的原始文件 hash：

- 实时后端身份与持久部署相同，后端恰好原 1 条加 UI 新 1 条评论；原评论未变，新评论只导入收件箱一次。
- 最新收件箱 revision 为 13，读取和 triage 均为 false，来源已停用。原内部处理的完整评论对象，包括状态、标签、备注与 revision，保持不变。
- 原 3 条 agent 消息及完整 timeline 精确相同，agent 空闲、无在途轮次、待审批或子 agent。UI 检查没有发送消息或新增原生工具调用。
- 原画布 HTML、数据和版本保持不变，服务端 interactions 为 0。Enter 队列的恢复和删除由真实 UI 截图证明；服务端零投递由独立读回证明。
- 252 个已安装文件与 `2063ca5` 的 bytes/modes 相同，原 16 张 Board 仍在目录中。只读收口的业务写入、权限修改、agent 消息和后端写入计数均为 0。

`readonly-final-invariants-1794207715566-a1ae2c.json` 补充原 triage 完整对象和初始作者 HTML/数据/版本的一致性断言。此补充探针首次误读不存在的 `board.data` 字段，失败记录单独保留；按实际 `board.canvas.data` 存储结构修正后通过，没有修改产品或数据。最终收口仅给出清理身份及 hash 合同，清理结果见下节。

## 保留的失败与修正

首轮全套源码测试为 610/612，通过 4 workers 限制后为 611/612；剩余失败是最大 UTF-8 来源的磁盘密集容量恢复用例超过原 5 秒上限。未改源码的单项诊断在 2.937 秒完成断言，诊断使用 20 秒观察上限，不作整合通过证据。最终将整个 inbox-sync 文件隔离运行，其余文件限制并发，原 5 秒上限下全部 612 项通过。原日志和资源隔离理由保存在 `source-timeout-diagnosis.md`，未修改产品或弱化断言。

第一次安装门控将一条 11 月 1 日的静止旧发布 `unknown` 记录误认作在途发布，等待 30 分钟后退出，源码修改与重载均为零。核查确认该精确记录没有自动发布授权或在途字段，旧/新版调度器都不会推进它。修正仅允许该字节未变的记录不阻塞空闲判断，保留其 unknown 状态和原始字节，不重试、不协调远端状态、不访问 GitHub；其他门控不变。原失败为 `install-app-backends-1794180961880-2adc1d.json`，核查为 `install-preparation/dormant-publication-root-review.json`，之后才执行上述成功安装。

## 专属 fixture 清理

清理以只读收口给出的身份与 hash 为合同，分三次运行。前两次各停在一处过严的检查，都发生在停用 Board 之前，原回执保留，后续运行不重做已确认的步骤。

| 运行 | 已确认动作 | 结果 |
| --- | --- | --- |
| `final-cleanup-1794207872449-20d5a1` | 后端 SQLite 一致性备份并停服；测试 agent 归档 | 归档后 canonical timeline 由持久历史重建：32 条条目与收口快照逐项相同，但 seq、messageId、时间戳和回合分组变化，原始 hash 检查因此停止 |
| `final-cleanup-continue-1794264374120-16ee6b` | 专属 workspace 归档；只含该 workspace 的项目记录移除（`removedWorkspaceIds: []`，daemon 只删记录不删文件） | 项目记录移除后 `fetchAgentHistory` 不再列出已归档 agent，`fetchAgent` 仍返回原身份；要求其仍在列表中的检查停止 |
| `final-cleanup-continue-1794264454781-fd1853` | 五次空闲采样通过；Board 停用、启用各一次（约 10 秒）；停用期间完整备份 plugin data，只移动 Board、inbox、connector 三个精确文件到私有 `moved/` | 状态 `fixture-cleaned-ui-absence-unverified`；原 16 张 Board 全部保留且内容未变，新 worker 池运行，daemon 未重启 |

接续脚本的门槛：timeline 逐项内容（忽略 `messageId`）必须与收口快照相同，任何新消息、工具调用或结果都会拦截；agent 历史列表中不得再有任何 fixture agent，`fetchAgent` 必须返回原身份且已归档；项目记录不得重新出现。空闲门控另外只按精确字节放行一条 10 月 30 日的历史失败投递：其交互已 applied、`awaitingTurn=false`、不在 active 中，插件的启动和恢复逻辑都不会处理它。三份接续脚本在 `cleanup-preparation/` 下；第一份执行前经过三路独立只读审查。

清理全程没有发送 agent 消息、写入评论来源、修改 main 或安装源码。应用源码、SQLite 数据、私有备份和三轮原生历史保留为证据。Board 已从 `board.list` 和磁盘消失；清理后没有再做 UI 目视确认。

## 使用边界

- 实际界面覆盖 Chrome 访客表单及已连接主 daemon 的原生 Paseo WebView（含 420×860 响应式视口）。独立 `app.paseo.sh` direct connection、物理手机、工作电脑和公司网络未通过本轮实际验证。实际快捷键补验限于 Enter 暂存/刷新/删除；Side、强制新 Side 和聚合主会话发送沿用组件测试，未新增真实 agent 投递。
- 评论由人明确同步导入，不自动唤醒 agent。读取和内部 triage 不授予改应用或公开回复；这些仍需单独授权和接口。
- 生产 HTTPS、DNS、公司认证和开机托管由目标基础设施提供；SSH 用于部署维护，访客通过 HTTP(S) 使用网页。CORS 不等于用户认证。
- 发布 API 仅访问随快照批准的 origin；不带 Cookie、不跟随重定向、不提供主机凭据。原生预览和磁盘文件没有可信 HTTP(S) origin，不能调用后端。应用需处理发布前状态、访客认证和提交幂等。
- 运行版本已安装；后续交付文档单独提交与同步，不代表重新执行运行时测试。草稿 PR 记录实际 UI 通过和 fixture 清理结果；main 未改。

首轮暂停在任何应用/权限操作前被全局插件数据一致性门控阻断；保留零动作失败记录。续办仅约束唯一测试资源，并单独记录无关数据的同期变化，不要求其他任务静止。

此前窗口不可用阶段的暂停回执为 `actual-20261109T001023602Z-664a5e4b9e/pause-1794183733373-12b830/receipt.json`。当时后端已备份停服，权限关闭、来源停用；本轮解锁后仅重启同一专属后端完成 UI 验收，部署身份不变。原 `cgWindowNotFound`、暂停及 direct connection 1006 失败均保留。暂停和 UI 续办没有重载插件、重启主 daemon 或新增 agent 消息。

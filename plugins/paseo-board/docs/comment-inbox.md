# Board 原生评论收件箱

评论收件箱保存发布页访客的留言。连接好的后端来源会由插件自动同步；人可以阅读、内部分类和亲自回复。用户另外确认「Agent 自动处理并公开回复」后，新评论会交给这张 Board 专用的**评论助手** agent，由它分类并公开回复访客。导入、读取和分类都不会创建 Board 讨论（interaction）；只有自动处理会发送消息，而且只发给评论助手，从不发给负责这张 Board 的主 agent 或它的 Side。

设计与取舍见 `DESIGN.md` §11（page-comments-20261113）。本文件说明插件里收件箱这一侧的实际行为。

## 权限

收件箱的 policy 有三项：`read`、`triage` 和 `auto`（`off` / `publish` / `review`）。新 Board 全部关闭。

| 谁 | 读取、列表 | 内部分类（状态、标签、备注） | 回复访客 | 导入、回复结果 | 归档 | 权限、来源 |
|---|---|---|---|---|---|---|
| 人（面板） | 可以 | 可以 | 可以，标为「作者回复」 | 不可以 | 可以 | 可以 |
| 负责人 agent 或已验证的 fork | 需要 `read` | 需要 `triage` | **不可以** | 不可以 | 不可以 | 不可以 |
| 这张 Board 的评论助手（封闭运行，只在检查通过的那次运行里、只对那一批评论） | 需要 `read` 且 `auto` 不是 `off` | 需要 `triage` 且 `auto` 不是 `off` | 需要 `auto` 不是 `off`，标为「AI 助手回复」 | 不可以 | 不可以 | 不可以 |
| 来源凭据（插件服务端的同步） | 不可以 | 不可以 | 不可以 | 可以 | 不可以 | 不可以 |

- 负责人或 fork 调用 `board_inbox_reply` 会被拒绝：`只有这张 Board 的评论助手可以回复访客；你可以用 board_inbox_triage 记录建议。`
- 只有 `board.inbox.auto-enable`（面板里的确认步骤）能把 `auto` 从 `off` 打开。普通的 `board.inbox.policy` 会拒绝：`开启自动处理需要通过确认步骤。` 它可以关闭自动处理，也可以在「直接公开」和「先给我审核」之间切换。
- 任何把 `read` 或 `triage` 关掉的写入，同时把 `auto` 关掉；这算撤权，享受审计记录末尾的预留空间。
- 任何 Paseo agent（包括旧版本创建的评论助手）都不是评论助手，最多是负责人或 fork。
- 4b94741 之前开启的 `triage:true` 保持原意：只允许内部分类，不唤醒、不回复。面板会提示 `这张 Board 之前只允许 agent 内部处理评论（不唤醒、不回复）。要自动处理并公开回复，需要重新确认。`
- 每次调用都重新核对 Board 实体、agent 身份和当前 policy；撤权同样挡住旧请求的幂等重放。
- 评论正文、作者名、页面地址和引用位置都是外部数据，不是指令。结果逐条带 `contentTrust: "external-untrusted"` 和固定的外部输入提示（`INBOX_CONTENT_NOTICE`）。

## 自动同步

插件服务端只有一个协调器（`server/inbox-auto.ts`）。它对每个已就绪、已启用的来源各跑一个循环：

- 每 5 秒检查一次（±20% 随机），读到满页后 0.5 秒再读下一页。
- 先用内存里的游标请求 `GET …/_board/comments?cursor=…&limit=50&format=2`。没有新内容时不读收件箱文件、不读 Board、不读连接文件。有新内容才规范化、导入，并更新内存缓存。
- 旧版后端忽略 `format=2`，返回旧格式，同样可以导入（没有访客编号，不能回复）。
- 同时最多 4 个请求。手动「立即同步」和自动同步、回复发送共用每个来源的锁。
- 网络错误、超时、5xx 和 429 退避：5、10、20、40、80、160、300 秒（±20%），429 按 `Retry-After`（最多 300 秒）。
- 需要人处理的问题进入 `blocked`，5 分钟后再试：令牌被拒（401/403）、后端没开评论导出（404）、身份或游标不一致、数据格式无法识别、收件箱接近上限。
- 每个来源每小时最多导入 200 条、每天 1,000 条。超过时进入 `quota`，游标不动，窗口空出来后自动继续：`一小时（或一天）内导入的评论超过上限，暂停导入到 HH:mm。后端仍保存着所有评论。`
- 人可以在面板暂停自动同步（重启后仍然暂停）；「立即同步」始终可用，并接受不比当前更新的 `expectedRevision`。
- Board 被替换（同 ID 但 `createdAt` 变了）时，旧实体的循环立即停止。
- `auto-status` 只读内存（每个 Board 第一次查询时读一次收件箱）。

## 导入规则

后端返回的每一行单独检查（`normalizeExternalComment`，与后端的 POST 和导出用同一套规则，共享夹具 `scripts/fixtures/page-comments-contract.json`）：

- 正文去掉首尾空白（包括全角空格），1–8,000 字；作者名去空白，空的去掉，超长或含控制字符的去掉；页面地址规范成 `new URL(v).href`，只允许 HTTP(S)、不带账号密码；引用位置（anchor）按 §4.1 检查键和长度；访客编号必须是 12 位十六进制。
- 必填项（`externalId`、正文、时间）不合格的行进入隔离区，选填项不合格只去掉该字段，未知字段直接去掉。游标照常前进，一行坏数据不会挡住同步。
- 收件箱保留最近 200 条隔离记录，来源上累计「已跳过」「已清理字段」数，面板显示 `已跳过 N 条格式不符的评论`。
- 只有信封（`deploymentId`、`cursor`、`nextCursor`、`comments`、`format`）不合格才停：`后端返回的数据格式无法识别（字段）。请确认后端由 paseo-board-app 生成，并已运行 update-runtime。`
- 按 `sourceId + externalId` 去重，比较规范化后的字段。同一个外部 ID 内容改变时整页拒绝并保留原证据。
- 新评论按导入顺序得到递增的 `seq`。更早版本导入的评论没有 `seq`，永远不会被自动处理。

## 评论助手：封闭运行（sealed runner）

设计见 `$PASEO_HOME/verification/paseo-board/page-comments-20261113/sandbox/DESIGN.md`（替代 `../DESIGN.md` §11.3）。旧版本的评论助手是一个 Paseo agent；实测它带着 Claude Code 的用户设置（用户的允许规则不经询问就能运行 python、git、WebFetch 等）、其他插件注入的 MCP 服务和预先允许的工具、其他插件追加的系统提示（包括用户的个人资料）运行，所以改为由插件自己启动的封闭进程。

**一次运行**（`server/inbox-runner.ts`，参数和检查在 `server/inbox-lock.ts`）：

- 每批评论启动一个 `claude -p`：命令取自 daemon 配置里的 Claude 提供方（`claude`，或 `extends: "claude"` 的提供方；路由逻辑是 learning-loop 套件 `server/kit/complete.ts` 的原样副本），不经过 shell，单独的进程组，标准输入只有评论编号，标准错误丢弃。提供方命令只能是可执行文件本身：后面带参数的（例如 `--append-system-prompt-file`，实测会把文件内容追加进系统提示而 init 看不出来）一律拒绝，`Claude 提供方的启动命令带有额外参数。插件无法确认这些参数不会给评论助手加上提示词或权限，所以不能开启。请在 Paseo 的提供方设置里只保留 claude 命令本身。`；运行器自己也再拦一次（不启动，算「不支持」）。
- 固定参数：`--output-format stream-json --verbose --no-session-persistence --model <模型> [--effort low] --max-budget-usd <单次上限> --tools "" --strict-mcp-config --mcp-config <只有 paseo_board> --allowedTools <四个评论工具> --disallowedTools <内置工具清单> --setting-sources "" --settings <锁定设置> --disable-slash-commands --permission-mode dontAsk --system-prompt <评论助手提示>`。锁定设置：`disableAllHooks`、`disableClaudeAiConnectors`、`autoMemoryEnabled:false`、`allowedMcpServers` 按 `paseo-board-mcp` 的完整命令路径锁定、`denyInsteadOfPrompting`、禁止切到 bypass 模式、同一份禁用清单。
- 环境：插件进程的环境去掉 Paseo 剥离的变量、所有 `PASEO_*`（角色变量除外）和 `*_BINDING`，加上提供方的环境（含凭据的提供方直接拒绝），再加 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 等几个保险变量，其中 `CLAUDE_CODE_HARBOR_KITE=0` 关掉跨会话消息（否则每次运行会开一个本机其他会话可以写入的消息 socket，init 里的 `messaging_socket_path`；2.1.325 实测有效，不列入启动检查）。工作目录是新建的 0700 临时目录，运行完删除。
- 唯一的 MCP 服务是插件自己的 `paseo-board-mcp`，带这次运行的令牌和 `PASEO_BOARD_TOOLSET=inbox-assistant`：只列出四个评论工具，别的名字在进程里直接拒绝。
- 启动检查（`verifyInit`）：第一条 `system:init` 必须在 30 秒内出现；工具恰好是四个 `mcp__paseo_board__board_inbox_*`、MCP 服务只有已连接的 `paseo_board`、权限模式 `dontAsk`、没有技能和斜杠命令、插件只有已核对过的 Claude Code 内置插件（按名字固定：`cc-plugin-agents-md`、`cc-plugin-telemetry`、`cc-plugin-privacy`、`cc-plugin-plugin-authoring`，来源 `<名字>@builtin`；新版 CLI 多出一个内置插件时先算违规，核对后再加入清单）、输出风格默认、工作目录就是这次的临时目录、Claude Code ≥ 2.1.319、模型是所选的。多出任何能力算「违规」（立即结束进程组，自动处理暂停，原因 `lockdown`）；服务没连上或模型不对算「未就绪」；版本旧或启动前就退出算「不支持」。init 之前出现模型输出也算违规；第二条 init 再检查一次。
- 标准输入只有评论编号（Board、批次和每条评论的编号、修订号、访客编号）；评论内容只能通过 `board_inbox_read` 读到。令牌只在内存里（`RunnerBindings`），检查通过后才「启用」，只能做四种收件箱操作、只限这张 Board 和这一批评论，进程结束或超时就作废；插件重启后旧进程什么也做不了。令牌的有效期（运行上限加 1 分钟）和运行时长从拿到主机名额时算起，排队的时间不算；令牌在进程还活着时过期（例如电脑睡眠），这次运行记为「中断」，这批评论退回重新处理。
- 运行中：每条 `tool_use` 都记下；不在四个评论工具里的名字记为「试图使用不存在的工具」（面板提示可能有诱导内容）；超过 `6 + 4 × 条数` 次调用、5 分钟、4 MiB 输出时结束进程组。结束时记下 `total_cost_usd`；可能已经调用过模型（init 检查通过，或者有模型输出）、却没有报告花费的运行（在上限处被结束、超时、被停止、异常退出），按它的 `--max-budget-usd` 计费（`costEstimated`，面板写「费用按单次上限计」）。模型的最终文字不保存。整台电脑同时最多 2 个运行。
- 运行看到的评论只有访客自己能看到的字段（`id`、修订号、状态、正文、称呼、时间、页面地址、引用原文和位置名、能否回复、公开回复）；内部备注、标签、来源、部署、发布版本和审计都不给。它可以写内部分类备注（保留作者原有的标签和备注，在后面追加）。回复和分类以 `paseo-board-inbox-runner:<哈希前 16 位>` 的身份记录，每张 Board 每小时 30 条回复的上限跨运行累计。

**开启**（`board.inbox.assistant-options` / `auto-enable`）：

- 选项：daemon 配置里第一个可用的 Claude 路由（没有：`自动处理需要本机的 Claude Code。Paseo 里没有可用的 Claude 提供方，所以不能开启。`；提供方环境里有凭据：`Claude 提供方的环境变量里有凭据。插件不会把凭据复制给评论助手进程，所以不能开启。`），以及 `paseo.providers.listModels` 里有标价的模型（`shared/assistant-models.ts`，价格表 2026-11：Haiku 5.5 $0.10/$0.50、Haiku 4.5 $1/$5、Sonnet 5.5 $2/$10、Opus 5.5 $4/$20 每百万 token），最便宜的推荐并预选；读不到列表时用 `haiku`/`sonnet`/`opus` 别名；没有标价的模型显示「无法估算」、不预选。
- 确认后先做**预检**：同样的启动参数，标准输入 `预检：不要调用任何工具。`，令牌不启用、没有评论，检查 init 后让它答一轮（这样也能发现登录或模型问题）。不通过就什么都不写，用 §3.9 的原话拒绝（Claude Code 太旧、找不到 claude、违规、未就绪、无法登录或调用模型、模型不可用）。通过后写入策略和评论助手记录（模型、提供方、每天花费上限、这次检查的时间和版本）。开启前已有的评论不会处理。

**批次和预算**（`server/inbox-auto.ts`）：

- 新评论导入后等 3 秒没有新导入再处理，同一批最长等 10 秒。一批是 seq 顺序里连续的、同一位访客（`visitorTag`）的合格评论，最多 8 条；没有访客编号的评论单独成批（只能内部分类）。同一张 Board 同时只有一个运行。
- 每张 Board 每小时 12 批，整台电脑每小时 30 批，超过时暂停并到时间自动恢复。每张 Board 每天的花费到上限（按 `total_cost_usd` 累计，预检也算；没报告花费的运行按单次上限计，插件崩溃时还在 `running` 的运行也是）时暂停到当地 0 点。单次运行的 `--max-budget-usd` 是估算上限的两倍（至少 $0.02）。面板里的「平均每条」只用报告过的花费。
- 运行记录先写入（`starting`），检查通过后为 `running`，结束时记结果、费用、工具调用次数和被拒绝的工具名，保留最近 50 条，面板显示最近 10 条。插件崩溃后，还在 `starting`/`running` 的记录变成 `interrupted`，这批评论退回重新处理（已处理的评论不再是「未处理」，不会重复）。
- 检查没通过（违规）时这批评论退回，不算交给了助手；未就绪或不支持时退回并在 1、5 分钟后重试，连续 3 次暂停（原因 `cli`）。人可以直接恢复 `cli`、预算和花费的暂停；`lockdown` 和升级后的 `setup` 只能通过对话框重新开启（会再做一次预检）：`请先重新开启自动处理：新版会先做锁定检查。`
- 关闭自动处理、Board 被替换、插件关闭时结束正在运行的进程组。
- 状态文件升级到版本 2：旧的评论助手记为 `legacyAssistant`（`reason: "unsafe-launch"`），自动处理暂停（原因 `setup`），收件箱权限不变；面板显示一次性的说明（含 agent 编号前 8 位），点「知道了」后不再显示。插件不自动归档旧助手（归档会让其他插件处理它的对话记录）。旧助手不再被当作评论助手：它的回复和以助手身份的分类都被拒绝。日志里旧版本留下的唤醒（`kind: "inbox"`）一律标为 `评论助手已改为封闭运行，旧唤醒未发送。`，不再发送。
- 只处理属于这张 Board 的评论：带 `releaseId` 的评论要求这个发布版本来自这张 Board；不带的，要求这台电脑上只有这一张 Board 连着同一个后端部署。已经不是「未处理」状态的评论不再处理。
- 插件还没拿到 Paseo 连接时，状态为「等待 Paseo 连接后交给评论助手」，每分钟再试一次，评论不会丢。

**测试**：`server/inbox-lock.test.ts`（参数、设置、环境、`verifyInit` 用调查记录里的 init 样例）、`server/inbox-runner.test.ts`（假进程：启用时机、超时、退出、违规、调用上限、费用、关闭）、`server/inbox-auto.test.ts`、`server/service.test.ts`（运行令牌的权限）、`server/runtime.test.ts`（真实 MCP 启动器的工具清单）、`npm run test:page-comments`（端到端，`claude` 用替身）、`node scripts/inbox-runner-harness.mjs`（真实 `claude` 二进制 + 假 API + 恶意的用户设置、钩子、MCP 服务和 CLAUDE.md）。

## 回复

`board_inbox_reply`（只有评论助手的运行能用）、CLI `paseo-board inbox reply --file …` 和人类 RPC `board.inbox.reply` 走同一条路径：

1. 文本统一换行、去首尾空白，必须是 1–2,000 字的纯文本。
2. 拦截看起来含私密信息的回复：这张 Board 任一来源的令牌、环境变量里的密钥值、`PASEO_BOARD_BINDING`、后端导出地址或它的主机名（只匹配完整的、带点的主机名或 IP，`api`、`board` 这类单个词不算）、`-----BEGIN`、JWT、常见服务商密钥、32 位以上的十六进制串、32 位以上大小写字母加数字混合的长串、本机用户目录路径。提示 `回复看起来包含私密信息（原因），未发送。`；只有人能在面板确认后仍然发送。
3. 先在收件箱写入「待发送回复」，它同时是这条评论的租约：同一评论有回复正在发送或待审核时，新的回复被拒绝。还要求评论有访客编号（`这位访客看不到回复（评论不是从页面评论功能发出的），只能内部处理。`）、少于 20 条回复、来源仍启用且部署没换；评论助手每张 Board 每小时最多 30 条（从收件箱记录计数，按这台电脑确认回复的时间算，不看后端时钟，重启不清零）。评论助手还只能回复这次运行的那批评论（`评论助手只能处理这一批里的评论。`；收件箱自己也检查：`评论助手只能回复唤醒它时列出的评论。`），回复里也不能出现其他访客评论里连续 16 个字以上的原文，访客之间互相看不到评论。回复里不能有 Unicode 双向控制字符（U+202A–U+202E、U+2066–U+2069）；收件箱面板把评论里的这类字符显示成 `[U+202E]` 这样的标记。
4. 「先给我审核」模式下，助手的回复保存为草稿，人点「发布」（原文，仍标为 AI 助手回复）或「修改后发布」（改过的文字标为作者回复），或「丢弃」。
5. 插件用来源的令牌 `POST …/_board/comments/<externalId>/replies`，幂等键 `ir-` + sha256(`boardId`, `expectedCreatedAt`, `commentId`, `eventId`) 的前 48 位。令牌只在插件服务端，不进入 agent、页面或任何结果。
6. 结果：成功后记为正式回复（`resolve` 默认把评论标为已处理）；网络、超时、5xx、429、401/403、后端没设置收件箱令牌（`export_disabled`）或关闭了评论（`comments_disabled`）时保持「发送中」，系统用同一个键重试（30 秒、1、2、5、10 分钟，之后每 30 分钟），24 小时仍未确认则标为失败；后端明确拒绝（评论不存在、后端过旧、编号冲突、已满 20 条）则标为失败，可由人重试或丢弃。后端已收下但本地记录失败时返回「已发送」（`recorded:false`），之后自动补记，不要换新的 eventId 重试。
7. 后端的导出不带回复记录（设计 §11.10 有意不做），这台电脑上的收件箱是回复的唯一账本。一条回复被标为失败、但后端其实已经收下时（例如 24 小时内本地一直没能记下），在面板点「重试」会用同一个键再发一次，后端认出是同一条回复，只补记、不重复发。收件箱从别处恢复或换一台电脑接同一个后端时，之前的回复不会出现在面板里，访客那边照常能看到。

## 存储、并发与限制

收件箱是独立、有界的 JSON 文件，版本仍为 1，新增字段都是可选的，旧文件照常读取（降级插件会拒绝新文件，不支持降级）。临时文件 `0600`，写入并 fsync 后 rename；拒绝符号链接和损坏文件，不自动重建。

- 修订号：权限、来源和归档要求精确的 `expectedRevision`（面板先读最新值，冲突时重试一次）；内部分类接受不比当前更新的修订号，以评论修订号为准；导入、回复及其结果不看收件箱修订号，分别由来源游标、评论修订号和待发送回复的键保护。
- 上限：32 个来源、5,000 条评论、20,000 条审计记录、32 MB。自动同步在 4,500 条评论、18,000 条审计记录或 28 MB 前停下，提示归档或换一张 Board；内部分类、回复和撤权仍可用。
- 归档：人可以把已处理、已忽略且没有进行中回复的评论移到同目录下的私有归档文件（`*.archive.jsonl`，0600），再从收件箱删除；`seq` 不变。来源重新登记并从头同步时，归档过的评论会再次导入。
- 协调器状态：插件数据目录下 `inbox-auto/<哈希>.json`（版本 2，0600，原子写入）保存同步暂停、评论助手记录、已停用的旧助手、已看过的 `seq`、运行记录、花费和暂停原因；`inbox-auto/host.json` 保存整台电脑的运行记录。版本 1 的文件在第一次读取时升级。只读查询一个 Board 的状态不会写文件。

## 接入接口

`shared/inbox.ts` 定义全部 Zod schema 和人类 RPC（`auto-enable` 的输入是 `replyMode`、`modelId`、`effort`、可选的 `dailyCapUsd`；`auto-status` 里有评论助手、最近 10 次运行、花费和交给你的评论数）：`board.inbox.list`、`read`、`policy`、`source`、`triage`、`reply`、`reply-pending`、`archive`、`auto-status`、`auto-set`、`assistant-options`、`auto-enable`；`shared/inbox-connection.ts` 定义 `connect`、`connections`、`sync`、`reconcile`。这些只注册为人类 RPC。agent 只有 `board_inbox_list/read/triage/reply` 四个工具（CLI `inbox list/read/triage/reply --file`），没有改权限、改来源或开自动处理的工具。

## 测试

- `server/inbox-store.test.ts`：共享夹具的全部导入用例、旧收件箱和旧 `triage` 授权、权限矩阵、待发送回复的租约与结果、预算重启不清零、审核模式、隔离与 `seq`、最新优先与 agent 列表上限、归档、余量停止。
- `server/inbox-sync.test.ts`：新旧导出格式、隔离、小页重试、回复请求头与幂等键、每种后端响应的映射、并发只发一次、本地记录失败后补记、私密信息拦截、24 小时失败（用模拟后端 `server/inbox-fake-backend.ts`）。
- `server/inbox-auto.test.ts`：手动时钟下的间隔、退避、阻塞、配额、并发上限、暂停持久化、Board 替换；模型选项和拒绝原话、预检失败什么都不写、按访客分批、运行令牌只够到自己那批、违规立即暂停、启动失败重试三次后暂停、12/30 批预算和每天花费上限、崩溃后中断并退回、关闭自动处理时结束运行、v1 文件迁移；回复重试与 24 小时失败。
- `server/inbox-lock.test.ts`、`server/inbox-runner.test.ts`：锁定参数、设置和环境，`verifyInit` 各条规则，运行的启用时机、超时、违规、调用上限、费用和关闭。
- `server/service.test.ts`、`server/runtime.test.ts`、`server/inbox-contribute.test.ts`：运行令牌只能做四种操作、只限自己的 Board 和那批评论、看不到内部备注；Paseo agent（含旧助手）不能回复；真实 MCP 启动器只列四个工具；旧唤醒不发送；RPC 注册。
- `scripts/inbox-host-checks.mjs`（`BOARD_HOST_TEST_SCOPE=inbox npm run test:host`）：面板文字、确认对话框（模型、估算、锁定检查中、拒绝原话）、各状态的提示、运行记录、旧助手说明、暂停与恢复、回复的重试与拦截确认、草稿发布、归档、420 宽度、工具栏提示点。
- `node scripts/inbox-runner-harness.mjs`：真实 `claude` 二进制、假 API、恶意的用户设置和 CLAUDE.md（见上文「测试」）。

以上都是插件内的隔离测试。真实 daemon、真实发布页和用户自己部署的后端上的验收由整合者和用户另行完成。

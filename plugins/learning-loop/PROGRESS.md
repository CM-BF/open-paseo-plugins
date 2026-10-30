# learning-loop：进度记录

当前交付：0.2.0 已在主 daemon 从稳定 commit `477bb9433ee27ab74783135682b3ffb3f8b5a559` 安装，82 tests + typecheck通过；真实验收与回退记录见文末及 `docs/verification/2026-10-22-v2-live.md`。

## 目标

把 Hermes Agent 的学习闭环搬给 Paseo 里的所有 agent（Claude Code、Codex、OpenCode…）：有界记忆（USER / MEMORY / 每项目 PROJECT）、agent 自己写的技能库、跨会话全文检索、回合后的后台复盘（把纠正和经验沉淀成记忆或技能）、curator 整理。设计与取舍见 `../../docs/hermes-to-paseo.md` §3.1。

## 参考来源（Hermes，`hermes-agent` worktree 81a55437f3）

- 记忆：`tools/memory_tool.py`（工具描述）、`tools/memory_tool_store.py`（`§` 分隔、批量只检查最终容量、唯一子串匹配、重复拒绝）、`agent/prompt_builder.py`（`build_memory_guidance`、`SESSION_SEARCH_GUIDANCE`、技能索引文字）、`tools/threat_patterns.py`。
- 技能：`tools/skill_manager_tool.py`（operations 批量、先读后写、描述 60 字符）、`agent/learn_prompt.py`（/learn）、`agent/curator.py`（`CURATOR_REVIEW_PROMPT`、stale/archive）。
- 复盘：`agent/background_review.py`（`_MEMORY_REVIEW_PROMPT`、`_SKILL_REVIEW_PROMPT`、`_COMBINED_REVIEW_PROMPT`）、`agent/turn_finalizer.py`（触发条件）。
- 检索：`tools/session_search_tool.py`。
- Paseo 侧：本机 `paseo-async-shell`（stdio MCP shim + unix socket + nonce 绑定）、`turn-check`（无头 `claude -p` 判官调用）。

## 设计决定

| 决定 | 原因 |
| --- | --- |
| 状态放 `$PASEO_HOME/learning-loop/`，不放插件目录 | 插件升级/重装不丢记忆和技能 |
| 记忆三类：user、memory、project（项目 = git 主仓库根，worktree 共用；非 git 用 cwd） | Paseo 用户同时开很多仓库，仓库专属事实不该占全局额度 |
| 工具逻辑全在插件进程，shim 只转发 | 单写者无需文件锁；TS 可测试；shim 路径稳定 |
| agent 的 delete = 归档；UI 的 delete = 硬删但内容进 ledger blob | 与 Hermes 一致：agent 和 curator 永不真删 |
| 先读后写按"调用方"（agent 绑定或复盘 run）跟踪，且要求文件自读取后未变 | Hermes 的 read-before-write；并发 agent 改同一技能时不互相覆盖 |
| 复盘用无头 `claude -p` + 仅本插件 MCP 工具，回放对话摘要 | Paseo 没有给插件的 fork；对应 Hermes"路由到便宜模型"的 review 路径 |

## 子任务

- [x] 调研与设计（`docs/hermes-to-paseo.md`）
- [x] 记忆存储：批量原子、容量、匹配、去重、威胁扫描、待审批队列、快照渲染（`server/memory/store.ts`，单测 15 个）
- [x] 技能库：create/patch/rewrite/write_file/remove_file/delete、先读后写、pin、归档/恢复、ledger + 单条回滚、使用统计、curator 确定性迁移、索引（`server/skills/library.ts`，单测 14 个）
- [x] 会话索引（node:sqlite FTS5 trigram，短词/无 FTS5 时 LIKE）与 session_search（单测 8 个）
- [x] MCP 工具定义 + 分发；unix socket bridge；shim 脚本（端到端单测 3 个，真 shim 进程 + 真 socket）
- [x] agent.create 注入（MCP + system prompt）与 session_open 绑定；before hook 失败放行
- [x] 无头调用 kit；复盘调度与运行；时间线卡片（引擎单测 4 个；真实 haiku 调用 1 次，opt-in `LL_LIVE=1`）
- [x] RPC 处理与客户端界面（Learning 屏五个 tab、设置屏、/learn /remember /review、Command Center、时间线渲染）
- [x] OVERVIEW.md
- [x] 装到主 daemon，用新建测试 agent 走真实流程；Web UI 截图验证（见下）

## 验证记录

2026-10-22，daemon 0.12.0（`srv_BSheQn5lzdEE`，`127.0.0.1:6767`，home `~/.paseo`），插件目录 `open-paseo-plugins/plugins/learning-loop`（本 workspace 的 worktree），截图来自 `scripts/shot.mjs`（无头 Chrome 打开 app.paseo.sh，裁掉 320px 个人侧栏）。

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 安装 / reload 后 `plugin ls` running，日志无错误 | 通过（首次安装发现 state 目录未建时 SQLite 打不开，已修复） | `paseo plugin logs learning-loop` |
| 已安装 shim 对真实插件进程：initialize / tools/list / skills_list / session_search | 通过 | 手工 JSON-RPC |
| 新建测试 agent（claude / Haiku 4.5，fixture `/tmp/plugin-test-20261022-ll`，agent `61c2c274…`，workspace `wks_bcd94ab6bc99b018`）调用 memory(project) / skill_manage create / skill_view / session_search | 通过：项目记忆落到 git 根 `/private/tmp/...`，绑定记录正确，检索返回其他 agent 的历史 | `paseo logs`，`docs/verification/2026-10-22-overview-desktop.png` |
| 自动复盘（安装后用户另一个 agent 的回合触发） | 通过：Sonnet 写出 `paseo-plugin-live-testing` 类级技能（步骤 + 规则式 pitfalls），$0.18；同时暴露"首次见到的 agent 把安装前历史也算进阈值"的问题，已修复并加单测 | `2026-10-22-activity-desktop.png`、`2026-10-22-skill-detail-desktop.png` |
| composer 里 `/remember project: …` | 通过：写入项目记忆，聊天里出现 "Remembered" 行 | `2026-10-22-slash-autocomplete-desktop.png`、`2026-10-22-remember-row-desktop.png` |
| composer 里 `/review` | 通过："reviewing…" 行被结果替换；Sonnet 判断测试会话 "Nothing to save"（$0.018） | `2026-10-22-review-running-desktop.png`、`2026-10-22-review-result-desktop.png` |
| Learning 各 tab（Memory / Skills / 技能详情 / Sessions 中英混合检索 / Activity） | 通过 | `2026-10-22-*-desktop.png` |
| 窄屏 420×860：Overview、Skills、技能详情（bottom sheet） | 通过 | `2026-10-22-*-compact.png` |
| 设置屏：改"Approve writes"→刷新后仍是新值，文件 `~/.paseo/plugin-settings/learning-loop/preferences.json` 同步；随后改回 off | 通过 | `2026-10-22-settings-desktop.png` |
| UI 里技能 History → Roll back（撤销 create）、Memory 里 Delete | 通过（同时作为 fixture 清理） | `2026-10-22-skill-history-desktop.png`、`2026-10-22-skill-rolled-back-desktop.png` |
| 清理 | 测试 agent 已归档、workspace 已归档、Paseo 项目 `prj_4f4fa292a4902d0d` 已删除、fixture 目录已删；插件数据里的 fixture 项目、索引行、ledger 行、usage/counters/binding 已删 | |

未验证：Codex / OpenCode agent 实际调用这些工具（只验证了 Claude Code）；手机原生 App（只验证了 Web 的窄屏布局）；curator 的 LLM 合并（`Consolidate with a model`）没有真实跑；`writeApproval` 开启时复盘写入进入待审批队列：存储层的暂存有单测，按调用方类型决定是否暂存的逻辑（`service.ts` 的 `stage`）没有单测也没有真实跑过。

## 已知问题 / 下一步

- 2026-10-22 的后续源码审计与实施准备见 [Skills / Learning / OMH 准备方案](../../docs/skills-learning-workflows-prep.md)。这是静态核查，以下修补尚未实现或通过新增运行验收。
- [x] 修复 writeApproval 只控制 memory、不控制 skill_manage 的范围遗漏；覆盖 curator 等全部技能写入口。
- [x] 复盘输入补当前 scope 的 memory 与 revision，避免盲 add；允许 Nothing to save。
- [x] 明确 synthetic 多 repo 的 workspace/repo 归属；保留同 repo worktree 共享，避免不同 repo 混写。
- [x] 增加 host 总预算，并移除 curator 将单次额度自动抬到至少 $1 的行为。
- [x] 补 provenance、scope、有效性与目录所有权；不原地改第三方安装件，不重复实现已有 Add / Edit / Delete。
- [ ] 补新建 Codex / OpenCode 的真实工具验收；现有“跨 provider 使用”不能表述为后台 review 不依赖 Claude。
- 旧版曾从本 workspace 的 worktree 加载；本次已改为独立持久 snapshot，位置和回退步骤见文末。
- 安装后对**所有**新 agent 生效（系统提示 + MCP 工具），并会对用户的真实会话做复盘（默认 Sonnet，每次上限 $0.50 标价）。不想要时在设置里关掉"Review agents after they work"，或 `paseo plugin disable learning-loop`。
- 0.12 的插件 SDK 没有 Markdown 组件，SKILL.md 以等宽纯文本显示。
- 窄屏 bottom sheet 不响应 Escape（宿主行为），截图脚本只能在 sheet 打开后结束。

## 可靠性切片（2026-10-22，实施与后续验收）

实现范围：P0 与第一批 P3，不新增外部记忆后端或同步原生 Claude/Codex memory。

- [x] `writeApproval` 同时控制 memory、skill_manage 的新建/编辑/资源文件/归档，以及确定性 curator 和模型 curator。Skills 页有完整 before/after 提案、批准、拒绝；批准时再次核对内容与有效性 revision。用户直接操作仍直接生效。
- [x] memory 元数据 sidecar：稳定 ID、content hash、内容+有效性 revision、source、actor/agent/run、created/updated、reviewDue、active/reference/archived。旧纯文本标为 legacy/source unknown，不捏造历史来源或日期；修改保留条目 ID。
- [x] 复盘传当前 scope 的 memory 与 skills/revisions。复盘写入用 snapshot revision 作 CAS；Nothing to save 是正常结果。手工复盘也保存 reviewedSeq，重复相同证据不会重新付费复盘。review 的 actor 保存 timeline epoch/fromSeq/toSeq 位置。
- [x] 全 host UTC 日预算：先持久化最坏单次预算的 reservation，再启动模型；完成按已知成本结算，未知成本保守收取预留额。未结算 reservation 重启后仍占当日额度；坏账本阻止启动，不重置额度。curator 与 review 共用预算，curator 不再抬高单次上限；排队后执行前重新读用户设置。
- [x] scope 区分 repo/workspace。真实 Git common dir 统一 worktree；synthetic workspace 本身保留 workspace 归属。新会话 `memory(project_path=...)` 可选 workspace 内的 repo（支持 symlink worktree），不偷偷选第一个 repo。
- [x] 新会话 v2 工具：memory read 与 scope/revision；session_search 默认 current，显式 host 跨项目。旧 binding 保持 v1 schema、原 host 搜索默认；没有改已有 system prompt，也不发 tools/list_changed。
- [x] session index 记录 scopeKey，SQL 查询在 limit 前过滤；新增保留期，只删除索引副本，保留 cursor 防止过期内容反复回填。UI 显式 scope path 和“Clear indexed copies”；要求先停索引，清除不会删源会话。
- [x] skill provenance/revision、reference/active 与 reviewDue；参考或到期内容不进新建 prompt index，但能显式 skill_view。LL 目录之外不扫描、修改第三方安装件；symlink 内容拒绝编辑。
- [x] opt-in `exports/learned-catalog.v1.json` 原子只读导出，供 Skills 中心通过明确路径消费；不开启不导出，停用导出会移除文件。没有跨插件源码 import，不复制到 provider 原生 skills 目录。
- [x] settings v2 migration：已有 writeApproval 选择保留（v1 缺省等于 off）；旧安装保留无限索引历史。新安装默认 background 提案、$2/UTC day、90 天索引保留；现有模型、阈值与每次预算不重置。
- [x] 回滚在修改文件前整批检查现值、完整保存 blob 与较新未撤销 ledger；支持倒序多次回滚。curator 提案如果技能后来被使用，审批拒绝。

### 静态/隔离验证

新增 `tests/reliability.test.ts`、扩展 `tests/review.test.ts`：真实临时 Git repo/worktree/symlink、SQLite FTS、真实文件存储/重启读取、并发 reservation、用户状态与模型提案冲突、旧/新工具 schema 分离、当前记忆输入与 Nothing to save、curator 精确预算/排队后预算变更。模型执行器仅在这些隔离单测中注入 fake；不访问用户 daemon 或数据。

2026-10-22 隔离检查：`npx tsc --noEmit` 通过；`npm test` 78 passed / 1 skipped（live-review 需 LL_LIVE=1，未启动）；客户端 DOM 审计仅命中 TypeScript 泛型，未发现 DOM 使用。

以上是实现阶段的隔离结果；随后完成的安装、live fixture 和截图见文末。后台执行器仍只支持 Claude-family。

### 明确剩余范围

- 可选 kb-learn EvidenceSource adapter 未实现；已记录当前会话 epoch/seq 与 actor/run 来源，没有复制第二套纠正分类器。
- 技能仍为 LL 自己拥有的 host library（身份 `learning-loop:host:<name>`）。本次没有自动迁移成每 repo 各一份技能，也不管理第三方原生安装件。
- `reviewDue` 表示需要复核，不是事实自动更新。过期仅影响新建快照；旧会话快照按缓存不变量保留。
- 日预算是 Claude CLI 返回的 list-price 估算，未知结果保守按预留上限计；不是向账单平台做强制费用封顶。UTC 日边界不退还前一日未结算 reservation。
- v1 legacy memory 待审项没有 revision 时仍使用原 pinned-entry 检查；新建项采用整份内容+有效性快照。
- 全部内容元数据使用 owner-only本地文件约定；文件系统外部并发编辑会导致 conflict/legacy 回退，尚未做进程崩溃中跨文本+sidecar 两文件原子事务证明。

### Live acceptance follow-up: workspace path aliases (2026-10-22)

- Main-daemon Haiku fixture exposed `/tmp` versus `/private/tmp` mismatch: the daemon canonicalized cwd but the explicit `project_path` used the normal `/tmp` spelling. The same workspace was rejected.
- Scope selection now recognizes aliases of the workspace ancestor before resolving mounted child worktrees. Unrelated absolute repositories remain rejected. Regression first failed on the original implementation, then passed; typecheck passed (19 reliability tests).
- Deployment and full live results will be recorded after the corrected stable snapshot is installed. No provider tool schema or existing prompt prefix changed.

### Native versus learned skills boundary (2026-10-22)

Parent's real Codex OMH acceptance run saw native skills in its provider catalog but treated a failed `learning.skill_view` lookup as proof that they were unavailable. The LL guidance did not distinguish the two catalogs clearly enough.

New agents now get an explicit boundary: only this block's `learning_loop_skills` belong to the learning MCP library; native skills use the provider's Skill tool or the advertised native SKILL.md path. Native packages are outside `skill_manage`. Missing learned-skill responses identify the library and give that fallback (v2+ calls). No native package is copied or changed.

New bindings use v3 descriptions with the same parameters as v2. The shipped v1 and v2 tool catalogs remain byte-identical (pinned SHA-256 contract tests), and existing stored system prompts remain unchanged. The real shim test checks v2/v3 discovery and the scoped error. 2026-10-22: typecheck passed; all 82 tests passed, 1 opt-in live-review test skipped. Parent will repeat the blind native-skill test in a new Codex agent after stable deployment.

### Main-daemon verification and stable delivery (2026-10-22)

- [x] Main daemon 0.12.0 / `srv_BSheQn5lzdEE`; exact data/settings backup with online SQLite snapshot; original preferences preserved through v2 migration.
- [x] Stable runtime: `~/.paseo/local-plugins/learning-loop/477bb9433ee27ab74783135682b3ffb3f8b5a559`, independent dependencies; running/ready logs. This no longer depends on the removable worktree.
- [x] Real desktop+compact Web UI: seeded skill proposal diff/approval, stale conflict/rejection, skill/memory validity and due dates, workspace/repo retrieval, UTC budget, export on/off with real Skills Center consumption.
- [x] New cheap Haiku fixture used v2 MCP scope/read/write; real test exposed `/tmp` alias bug, fixed and repeated successfully.
- [x] Exact owned fixture agent/workspace archived, project deleted, UI content deleted, index/binding/owned metadata traces cleaned. Other agents and their fixtures unchanged.
- [x] Final full suite after native-catalog boundary fix: 82 passed / 1 skipped; typecheck passed. Old v1/v2 catalogs frozen by output-hash contracts; v3 only for new bindings.
- [x] Parent reports fresh Codex blind native-skill test `4cae8e14-5faf-43fc-b83a-7b0bbd44d131` passed after `477bb94`: native files loaded directly; no false Learning MCP miss. Parent owns screenshot/cleanup. Codex memory-write, OpenCode/native mobile and live model curator remain unverified.

Complete evidence, fixture IDs, screenshots, backup location and old-code restore procedure: `docs/verification/2026-10-22-v2-live.md`. `paseo plugin remove` deletes plugin-settings as well as the registration; save/restore settings before reinstalling a directory source. Never restore the whole earlier memory/index backup over newer user work merely to revert code.


### Final shared-fixture cleanup (2026-10-22 local / 2026-10-23 UTC)

Parent OMH fixture agents `74fb4edf…`, `7e68df10…`, `4cae8e14…` were archived before exact-ID Learning Loop cleanup. Removed 3 indexed sessions / 38 messages / 3 bindings; no matching review/counter records existed. Real UI idle gate (`running=0`, `queued=0`) preceded reload of stable `477bb94`; afterwards all fixture record counts were 0 and logs clean. Budget, original preferences, and real `paseo-plugin-live-testing` skill hashes were unchanged; export remains off. Exact IDs, backup location and counts are in `docs/verification/2026-10-22-v2-live.md` and its runtime JSON. No code changed after the 82-pass/typecheck verification.


### Upstream Watch provenance (2026-10-24)

Added packaged `UPSTREAM.json` for explicitly recorded reference commits and feature paths. This is source metadata for the new Upstream Watch discovery flow; plugin runtime code and live installation were not changed. Prior runtime verification remains as recorded above.


### Memory exhaustion repair (2026-10-29, 0.2.1)

- Incident: Paseo 0.13.2 `timeline.refetch` resumes unloaded providers. Startup backfill in Learning Loop 0.2.0 resumed 137 agents, with each Codex provider able to spawn MCP children; the app tree reached 2,606 processes and the user saw 120.50 GB. Disabling this plugin and restarting the daemon stopped that cascade. This is provider/process fan-out, not proof of a JavaScript object leak.
- Replaced indexing's SDK timeline reads with bounded, read-only Claude/Codex native transcript reads. No SDK/provider/process launcher dependency in the source; no fallback that resumes sessions. Stable file snapshots, line/file/text/entry limits, configured provider roots, internal/thinking/tool-output filtering and explicit unsupported/missing/corrupt-file errors preserve old copies on read failure.
- Serialized startup, manual and lifecycle indexing through one queue. Added cancellation checks after awaited operations, snapshot release, coalesced follow-ups with generation ownership, and one retention prune per session. Review behavior and provider tool catalogs are unchanged.
- UI now says “Index saved sessions”; version 0.2.1 and documented supported-provider/size limits. User preferences, memories and skills are preserved.
- Regression baseline: 13 of the first 18 new safety tests fail against the original sync implementation; they pass with the queue/cancellation fix. Additional review caught and fixed clear-then-immediate-same-agent reindex ownership. Final isolated validation: Node 24 typecheck passed; 113 tests passed, 1 opt-in live-review skipped (no paid model execution needed for file-indexing changes).
- Read-only real-corpus probe: 960 persisted non-internal records, 918 readable; 19 missing transcripts, 17 unsupported providers (13 Pi, 4 OpenCode), 6 missing session IDs. Final channel-filtered probe: 34,090 entries, sampled heap peak 104 MiB; no daemon APIs or provider processes used. Codex analysis/internal assistant channels are excluded.
- Original runtime: `/Users/citrine/.paseo/local-plugins/learning-loop/477bb9433ee27ab74783135682b3ffb3f8b5a559`. Owner-only pre-fix data/settings backup: `/Users/citrine/Documents/Codex/2026-10-29/bang/work/paseo-memory/pre-fix-state/`. `plugin-data/learning-loop` does not exist; actual data is `~/.paseo/learning-loop` and settings `~/.paseo/plugin-settings/learning-loop`.
- Initial implementation commit preceded live deployment; completed results follow below. Never restore the whole data backup over newer user work to revert code.


### Live 0.2.1 acceptance (2026-10-29)

- Main daemon 0.13.2 / `srv_BSheQn5lzdEE`, same supervisor 40554 and worker 40556 throughout plugin deployment. Runtime now `/Users/citrine/.paseo/local-plugins/learning-loop/ed7cca337021c32183d8ecf843b4ed199f9d1523`, independent copied dependencies, enabled/running, log confirms 0.2.1 ready.
- CLI install rejected an existing runtime ID; removed the already-disabled registration, restored exact saved plugin-settings before install, and installed the stable new path. Settings SHA-256 stayed identical; all 467 backed-up memory/skill files stayed byte-identical. Source transcripts were never changed.
- Startup backfill and manual “Index saved sessions” ran on the real daemon. Original enumeration scope remains unarchived agents; about 200 current sessions now have native-v1 epochs. Existing archived/unsupported index copies remain. Read-only corpus probe separately covered 960 records, 918 readable and 34,090 native entries at a sampled heap peak of 104 MiB.
- Real desktop UI at `paseo://app/h/srv_BSheQn5lzdEE/plugin/learning-loop/surface/main`: new button visible; indexed session/message counts updated; search for quoted Learning Loop returned 11 matching sessions including archived records. No fixture agents or model calls were created for validation. Existing user activity and the unchanged background review settings continued.
- Web attempt at `https://app.paseo.sh` failed to connect to localhost from the available controlled browser. Desktop UI was verified instead; compact Web layout remains unverified. No security protections or daemon CORS settings were changed.
- Screenshot: `/Users/citrine/Documents/Codex/2026-10-29/bang/outputs/learning-loop-fixed.png`. Detailed outcome, runtime source and rollback notes: `/Users/citrine/Documents/Codex/2026-10-29/bang/outputs/learning-loop-repair.md`. No credentials or conversation snippets are in the screenshot/report.
- Three-minute live observation: zero Learning Loop agent-resume records, health 200, no provider fan-out. Whole-app activity included other ongoing agents and normal reviews; RSS sums are not plugin-private memory. Daemon physical footprint measured ~1.31 GB, below its pre-repair recovery sample ~1.73 GB. Final monitoring summary is recorded in the delivery report.
- Final code validation: Node 24 typecheck passed; 113 tests passed / 1 opt-in live-review skipped. No changes to code after that validation.

# Dynamic workflow review disposition

2026-10-22。接续原生 Claude Workflow `wf_c0e2e361-09e`，复用已有审查与复核结果，没有重跑已完成的审查。恢复后的输出有84条保留意见、4条反驳、79项建议；保留意见包含重复，部分只完成单个 verifier，并非84个独立且完整验证的问题。完整性 critic 因额度限制未产出最终结论，本次由三位独立 agent 对修复交叉复核补充。

本次修复：worker消息洪泛/卡死检测、排队预算与Skip、严格脚本环境、resume顺序/失败位置/worktree元数据、子agent配置/权限/生命周期、worktree所有权、通知持久化、关闭竞态、传输和CLI、界面分页/紧凑轮询/设置保存。第二轮发现的真实SDK模式元数据、误删已有分支、关闭后延迟启动、启动关闭竞态和缓存失败位置错位也补充回归。

验证以 `PROGRESS.md` 最终记录为准：159个测试，typecheck，主daemon0.12真实Codex父/子agent、缓存resume、隔离工作区、Stop、reload以及桌面/420px Web截图。原生手机、真实跨provider受限权限模式未做这轮实机验收；相应逻辑有SDK/假传输行为测试。

## 原始保留意见逐项处理

编号为恢复输出数组的零起始索引；重复意见仍保留便于追溯。

| # | 来源 | 严重度 | 原始意见 | 处理 |
| --- | --- | --- | --- | --- |
| 0 | runtime | critical | A synchronous loop that calls log()/phase()/agent() defeats the stuck-loop watchdog and floods the plugin process (memory, journal, stop/dispose hang) | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 1 | runtime | high | Budget ceiling is checked only when agent() is called, so queued calls start after the budget is spent | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 2 | runtime | medium | pipeline() keeps running later stages after a stage returns null (Claude stops that item) | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 3 | runtime | medium | Resumed worktree-isolation calls lose their branch and worktree, so the notification omits branches the parent must merge | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 4 | runtime | medium | Configuration errors such as an unknown agentType make agent() return null instead of throwing | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 5 | runtime | low | Script body compiled in sloppy mode with the API names as parameters of the same function, so scripts valid in Claude fail after 'launched' | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 6 | runtime | low | Determinism ban is bypassed by Date's prototype.constructor and by Intl.DateTimeFormat().format() | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 7 | runtime | low | workflow() nesting limit is bypassed through globalThis.workflow, giving unbounded recursion | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 8 | runtime | low | Resume cache assigns same-key results in completion order, so an unchanged script returns results in a different order | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 9 | runtime | low | Some unsatisfiable schemas are accepted, wasting 3 repair turns before agent() returns null | 修复显然矛盾的约束；不做一般 schema 可满足性求解。 |
| 10 | runtime | low | Per-call item cap is 1000, not Claude's 4096 | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 11 | runtime | low | A child created while the plugin shuts down can be left running and unarchived | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 12 | runner | high | A child with no resolved model (provider override, profile without a model, or a parent with a null model) fails before it reaches the daemon | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 13 | runner | high | A child that is archived or stopped mid-turn counts as a success, and with a schema it is unarchived and re-prompted | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 14 | runner | high | Worktree branch names collide after Paseo slugifies them to 50 characters, so parallel worktree agents fail or branch off a sibling | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 15 | runner | medium | Schemas that declare a draft-07 or draft-04 $schema (or use tuple `items`) throw at agent() | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 16 | runner | medium | The documented `cwd` option is ignored for non-worktree children: they run in the parent's directory | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 17 | runner | medium | A daemon connection drop fails every in-flight agent and leaves the children running unarchived | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 18 | runner | medium | Children whose create was in flight when the plugin stopped are never archived | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 19 | runner | medium | OpenCode model ids (which contain a slash) are parsed as provider/model | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 20 | runner | low | Removing an unchanged worktree ignores the daemon's error result, so leaked worktrees go unnoticed | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 21 | runner | low | Unchanged worktrees are removed but their branches are not, so every isolated agent leaves a branch behind | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 22 | runner | low | Usage from turns that time out, are skipped or are stopped is never counted, so the budget can be overshot | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 23 | runner | low | The reported worktree branch can be the pre-rename name, because the daemon renames the branch asynchronously | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 24 | service | high | A notification whose send fails after the daemon has written its receipt can never be delivered, and it blocks every later notification to that agent for 3 days | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 25 | service | high | Any refresh error makes the notifier drop every queued notification for the agent; a plugin reload or daemon restart loses the 'interrupted' notification for good | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 26 | service | medium | Stopping the plugin leaks children whose agents.create is in flight, and recovery never removes unchanged worktrees of interrupted isolated children | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 27 | service | medium | For a workflow launched by name, the editable script path is the user's saved library file, so iterating edits ~/.claude/workflows or the repo's checked-in workflow | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 28 | service | medium | Runs are never pruned: each panel poll reads and parses every run.json on disk, startup recovery reads them all while agent creation waits, and run detail sends every call | 摘要索引与有界 LRU 已修复轮询；历史保留策略明确记录，不自动删运行。 |
| 29 | service | low | Runs that end while isolated agents are still in flight send a notification whose <worktrees> list leaves out those branches | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 30 | service | low | Stop from the card or panel can exceed the daemon's 30 s plugin RPC timeout and report failure while the stop is still going through | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 31 | service | low | The workflow shim retries a non-idempotent launch on ECONNRESET, so a reload during a launch starts the run twice | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 32 | service | low | Cleanup leaves timers running, so the plugin process cannot exit by itself and is sent SIGTERM 2 s after every stop or reload; timers also fire after dispose | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 33 | service | low | The final card update is never retried, and one global warning flag hides every later card failure | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 34 | transport | high | The preapproved workflow tool lets an agent in a restricted permission mode start children in another provider's more permissive default mode, with no prompt | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 35 | transport | medium | Recursion is only blocked by not advertising the tool: the bridge accepts launches from workflow children | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 36 | transport | medium | Injecting the MCP server into every OpenCode agent forces a dedicated `opencode serve` process for each agent | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 37 | transport | medium | An oversized request is reported as 'plugin not reachable' after about 20 s of re-sending the whole body | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 38 | transport | low | Any caller can stop, read or resume any other agent's run, and an unidentified caller lists every agent's runs | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 39 | transport | low | After a plugin reload mid-turn, workflow launches fail with 'try again in a few seconds' until some unrelated lifecycle event happens | Paseo0.12 API 限制：中途 reload 后需 hook/RPC；提示打开面板。 |
| 40 | transport | low | If the bridge cannot listen, startup is still 'ready' and new agents get tools that point at a dead socket | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 41 | transport | low | The CLI silently drops misplaced arguments and unknown flags | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 42 | client | medium | After a restart the run card can stay at 'Running' forever, with a ticking timer and a Stop button that does nothing | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 43 | client | medium | Panel shows at most 120 agents per phase: running or failed agents further down cannot be seen, skipped or opened | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 44 | client | medium | Settings number fields save every keystroke: out-of-range input silently keeps a prefix, clearing a field saves 0, and fast typing hits revision conflicts | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 45 | client | medium | Live run view downloads the whole run every 1.5 s (2.4 MB for 1000 agents) and re-renders every call row every second | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 46 | client | medium | Skip on a queued agent shows 'Skipping' but nothing changes until a slot frees; repeated taps all report success | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 47 | client | low | On iOS and Android, text in several rows overflows its container (no flexShrink); the web screenshots don't show it | flexShrink 已修复，Web420px 已验；原生 iOS/Android 未实机验证。 |
| 48 | client | low | Transcript stops refreshing as soon as the child finishes, so it usually misses the final reply | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 49 | client | low | Panel state carries over between runs: Stop stays 'Stopping…' and expanded rows reappear on the next run | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 50 | client | low | 'N active' counts queued agents, so a phase reads '0/200 · 200 active' while only 6 agents run | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 51 | docs | high | Documented opts.provider (and profiles without a model) always fail: agent() returns null | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 52 | docs | medium | Launching a saved workflow by name tells the agent to edit the user's saved workflow file in place | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 53 | docs | medium | OpenCode model ids ('anthropic/claude-…') are misread as provider/model and the child fails | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 54 | docs | medium | Invalid agentType or provider resolves to null instead of throwing as REFERENCE promises | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 55 | docs | medium | Built-in roles 'explore', 'plan' and 'verification' are documented as read-only but only get a prompt line | 文档改为提示词角色，权限模式另外保守继承；角色不承诺强制只读。 |
| 56 | docs | medium | Budget is described as a hard ceiling, but pi and Codex children report almost no tokens | 部分 usage 已补，仍以 provider 上报为准；文档取消实际花费硬上限承诺。 |
| 57 | docs | low | Top-level `const log/agent/phase/args/workflow` passes the launch check, then the run fails with SyntaxError | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 58 | docs | low | meta.whenToUse is documented as shown for saved workflows, but nothing shows it and agents cannot list saved workflows | 更正文档，whenToUse 只保留元数据；未新增保存 workflow 目录浏览功能。 |
| 59 | docs | low | CLI (pi/omp) callers get MCP-only iteration and resume hints, and the CLI prompt omits --script-path and --name | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 60 | docs | low | 1000-item limit per parallel()/pipeline() call differs from Claude's 4096 but is missing from the README differences | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 61 | tests | medium | The budget test never reaches the hard-ceiling throw it is named after | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 62 | tests | low | The 'computed value' meta case is rejected by the meta-first rule, not the literal check | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 63 | tests | low | The stop, sync-loop and parallel tests claim behaviours that no assertion checks | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 64 | tests | low | The pipeline no-barrier test depends on a 150 ms sleep | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 65 | tests | low | dispose() awaits the final run saves of an engine list that interrupt() has already emptied | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 66 | parity | high | Token budget does not stop agent() calls that are queued inside one parallel()/pipeline() fan-out | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 67 | parity | medium | Resume hints omit args and args are not persisted, so following the hint resumes with args undefined | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 68 | parity | medium | Budget directive parser matches '+Nk' anywhere in the message, so ordinary text sets a tiny hard ceiling | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 69 | parity | medium | agent() resolves to null where Claude throws (unknown agentType, schema failure, creation errors), so Claude saved workflows complete silently with null results | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 70 | parity | medium | A launch by name returns the saved workflow definition as the editable 'Script file', so iterating edits the user's shared workflow | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 71 | parity | low | setTimeout/clearTimeout are missing from the script context (Claude provides them) | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 72 | parity | low | The 'Transcript dir' in launch and status output holds no transcripts, and children are archived, so the agent cannot inspect what a child did | 更正 run 文件说明，提供 journal/面板 transcript；未导出独立 transcript 文件。 |
| 73 | parity | low | The completed-run notification gives no failure reasons and no journal pointer | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 74 | parity | low | Budget lookup scans only the last 200 timeline entries without paging, so a long scouting turn loses the user's '+Nk' directive | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 75 | parity | low | workflow_stop from the launching agent on a run the user is already stopping suppresses the final notification | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 76 | paseo-api | high | agent() with opts.provider (and no model), or an agentType profile without a model, always returns null: the SDK rejects a bare provider | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 77 | paseo-api | medium | opts.cwd is silently ignored: with parent set, the daemon places the child in the caller's workspace and cwd | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 78 | paseo-api | medium | A child the user stops or archives counts as completed with partial text; with a schema, the repair prompt unarchives and restarts it | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 79 | paseo-api | medium | Child agents leak when the plugin stops mid-run: no archive on disable or remove, and children still being created are never recorded | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 80 | paseo-api | low | workspaces.archive reports failure in its result payload; the runner ignores it, so the unchanged worktree is left behind unreported | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 81 | paseo-api | low | runs.stop can take longer than the host's 30 s plugin RPC timeout, so Stop shows an error while the stop goes ahead | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 82 | paseo-api | low | A notification can interrupt a turn the user starts between the idle check and the send | 已修复并纳入相关行为回归；重复项共用实现与验证。 |
| 83 | paseo-api | low | The Paseo API is captured only from hooks and RPCs: launch fails after a reload when no hook arrives, and archiving leftovers gives up after 10 minutes | 恢复等待不再10分钟失效；首次API仍依赖Paseo0.12 hook/RPC，已明确提示。 |

## 保留的实际限制

- Token预算取provider报告的用量；未报告的token和已在运行的子agent可能让实际消耗超出目标。
- 内置explore/plan/verification为提示词；不能替代provider权限模式。跨provider无法保守映射权限时拒绝创建。
- Paseo0.12 plugin entry没有PaseoApi。中途reload后若没有任何hook/RPC，需打开一次面板；恢复等待不再静默过期。
- 不自动删除历史运行；列表用摘要索引，完整记录LRU最多100条。
- 模糊通知receipt保留在outbox并标记uncertain，不换key盲目重发，不阻塞后续通知；可从status/面板取结果。
- 插件停止时，已经在daemon端发出但尚未返回的create无法由公共API撤销。创建前保存agentId，下一次启动按id和label恢复归档；这段间隙不是原子取消。
- 旧隔离运行缺少baseSHA时保留现场；新运行能验证未修改worktree并检查实际删除结果。

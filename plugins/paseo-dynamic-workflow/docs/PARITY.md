# 原生 Workflow 对照差异台账

本表追踪2026-10-24审查确认的86条差异，依据当前提交94f9bda分类。它不是“86项全部修复”的声明。原始审查另有1条被反驳、1条未核实，未混入本表。部分项目只通过隔离回归，真实provider限制见[验收记录](verification/2026-10-24-parity.md)。

“已处理”表示表中核心差异已改；“部分改善”仍有明确缺口；“保留差异”是目前的适配选择或宿主边界；“尚未对齐”仍需后续工作，不能算验收通过。

| ID | 严重度 | 状态 | 审查结论 | 当前范围 |
| --- | --- | --- | --- | --- |
| children-1-2 | high | 部分改善 | No stall detection, no automatic retry, no attempt counter, no per-agent Retry | 已加卡死检测、最多3次尝试和手动Restart；原生重试阈值、退避及限流等待尚未完全一致。 |
| progress-1-1 | medium | 已处理 | The user cannot retry (restart) a single running agent | 见代码、PROGRESS.md和验收记录。 |
| lifecycle-1-6 | low | 尚未对齐 | No usage-limit wait: children that hit a quota just fail, and queued calls keep failing | 本轮未覆盖该差异。 |
| lifecycle-1-5 | low | 尚未对齐 | No pause or resume control for a run | 本轮未覆盖该差异。 |
| notify-1-1 | medium | 已处理 | A run the user stopped wakes the parent and tells it how to resume | 见代码、PROGRESS.md和验收记录。 |
| notify-1-13 | low | 尚未对齐 | A stop by the parent itself produces a later notification turn | 本轮未覆盖该差异。 |
| progress-1-3 | medium | 部分改善 | Agents cut off by Stop, interrupt or early return are shown and counted as 'skipped' | 通知已区分cut-off；面板的skipped呈现尚未全部拆分。 |
| resume-1-2 | medium | 部分改善 | Each resume gets a new run ID and journal, so results do not accumulate across resumes and earlier work is lost | 跨链结果按完整调用前缀继承；每次resume仍使用新run ID。 |
| resume-1-10 | low | 保留差异 | Resume without args keeps the saved args instead of running with no args | 见代码、PROGRESS.md和验收记录。 |
| launch-1-5 | low | 部分改善 | Launch result lacks the empty-cache caveat, the where-to-watch line and a plain re-run hint, and contains awkward or MCP-only wording | 见代码、PROGRESS.md和验收记录。 |
| parent-1-9 | medium | 部分改善 | Launch results and notifications use a bare `paseo-workflow` command that is not on PATH, and MCP parents get CLI hints too | 见代码、PROGRESS.md和验收记录。 |
| parent-1-4 | medium | 保留差异 | Launch approvals: the built-in asks the user to review each launch, the plugin preapproves every launch by default | 保留可配置的默认预批准。 |
| parent-1-3 | medium | 已处理 | For Claude parents the workflow tool description is cut at 2048 characters, and the reference tool needs a tool search first | 见代码、PROGRESS.md和验收记录。 |
| launch-1-14 | low | 尚未对齐 | Opt-in text differs from the built-in: no cost rationale, a softer ask, and an extra rule that one opt-in covers later phases | 本轮未覆盖该差异。 |
| optin-1-18 | low | 尚未对齐 | Ultracode's solo exemptions are broader than Claude's | 本轮未覆盖该差异。 |
| optin-1-13 | low | 尚未对齐 | Under Ultracode, check-in after the 4th run per user message (Claude has none) | 本轮未覆盖该差异。 |
| runtime-1-4 | medium | 保留差异 | budget.spent() is per run and counts only this run's children, at turn end; Claude's pool covers the whole turn | 只能核算插件可见的子agent用量。 |
| runtime-1-2 | medium | 已处理 | Script-level failures never reach the notification's <failures> list or the agent counts | 见代码、PROGRESS.md和验收记录。 |
| runtime-1-11 | low | 尚未对齐 | parallel()/pipeline() after the cap or budget is exhausted: Claude rejects the call, the plugin returns all-null and logs every slot | 本轮未覆盖该差异。 |
| runtime-1-7 | low | 尚未对齐 | The schema root rules are stricter than Claude's: `properties` required, undeclared `required` names rejected | 本轮未覆盖该差异。 |
| runtime-1-8 | low | 尚未对齐 | effort, isolation, prompt and opts values that Claude ignores make the plugin's agent() throw | 本轮未覆盖该差异。 |
| runtime-1-15 | low | 已处理 | Default concurrency is min(8, CPUs-2) with a floor of 1, against Claude's min(16, max(2, CPUs-2)) | 见代码、PROGRESS.md和验收记录。 |
| children-1-5 | medium | 保留差异 | Structured output uses prompt + JSON extraction + 3 repair turns instead of a validated tool with in-turn retries (cap 5) | 跨provider使用JSON提取与纠正轮次，未模拟原生StructuredOutput工具。 |
| notify-1-6 | low | 尚未对齐 | Result cap, truncation marker and empty-return handling differ, and truncation detection gives false positives | 本轮未覆盖该差异。 |
| resume-1-1 | high | 已处理 | Resume matches each call on its own instead of reusing only the longest unchanged prefix: unchanged calls after an edited or failed call still come from the cache | 见代码、PROGRESS.md和验收记录。 |
| children-1-1 | high | 已处理 | Child prompt has no computed-task provenance frame and no indentation | 见代码、PROGRESS.md和验收记录。 |
| reference-1-5 | medium | 尚未对齐 | Children do not get the parent's session MCP servers, and REFERENCE states this as fact although it is untested | 未单独实测父会话专属MCP继承边界。 |
| parent-1-7 | medium | 保留差异 | The notification is a real user message, so providers' harnesses treat it as human input | 宿主以user_message投递，插件增加自动事件边界；无法提供Claude内部通知角色与回合内合并。 |
| parent-1-16 | low | 尚未对齐 | The notification's opening line and summary differ from the built-in | 本轮未覆盖该差异。 |
| notify-1-14 | low | 尚未对齐 | Notifications arrive only between turns and each one gets its own turn | 本轮未覆盖该差异。 |
| optin-1-2 | medium | 部分改善 | The "ultracode" keyword is never confirmed: the model has to spot it itself, with looser rules, and is told it permits a workflow rather than asks for one | 见代码、PROGRESS.md和验收记录。 |
| reference-1-3 | medium | 已处理 | Without Ultracode, the scale guidance pushes runs larger than the built-in does, and two of its rules conflict | 见代码、PROGRESS.md和验收记录。 |
| parent-1-1 | high | 部分改善 | Claude parents see two workflow tools, and Claude's own 'ultracode' reminder points to the built-in one | 已要求Claude在Paseo中优先使用插件；原生Workflow仍可能同时可见。 |
| launch-1-1 | medium | 已处理 | Script parse errors have no code frame or caret, and the plain-JavaScript hint only appears when a narrow TypeScript regex matches | 见代码、PROGRESS.md和验收记录。 |
| launch-1-2 | medium | 已处理 | Launch-time script errors never point the agent to workflow_reference, and carry an internal error-code prefix | 见代码、PROGRESS.md和验收记录。 |
| launch-1-4 | low | 尚未对齐 | Named workflows are looked up by file name, not by meta.name; files that do not parse are listed as available; only cwd and git root are searched | 本轮未覆盖该差异。 |
| launch-1-9 | low | 尚未对齐 | Meta validation is stricter than the built-in: valid Claude scripts are rejected and meta.title is dropped | 本轮未覆盖该差异。 |
| launch-1-10 | low | 尚未对齐 | Static determinism check covers a different set of scripts and syntax than the built-in's | 本轮未覆盖该差异。 |
| launch-1-11 | low | 尚未对齐 | Tool input schema differences: no maxLength on script, no ignored description/title fields, additionalProperties:false, and resume text does not state the same-agent rule | 本轮未覆盖该差异。 |
| launch-1-12 | low | 部分改善 | Docs disagree with the code about saved files replacing built-ins, and a skipped project override is invisible | 见代码、PROGRESS.md和验收记录。 |
| launch-1-13 | low | 尚未对齐 | Script file is runs/<runId>/script.js instead of a name-bearing <name>-<runId>.js | 本轮未覆盖该差异。 |
| runtime-1-5 | low | 尚未对齐 | Non-string label, phase and phase() titles throw instead of being converted to strings | 本轮未覆盖该差异。 |
| runtime-1-6 | low | 尚未对齐 | console.* keeps only its first argument and has no warn/error marker | 本轮未覆盖该差异。 |
| runtime-1-9 | low | 尚未对齐 | The Math.random() guard gives timestamp advice instead of a hint about sampling | 本轮未覆盖该差异。 |
| runtime-1-10 | low | 尚未对齐 | Agent-cap and budget errors lack Claude's diagnostic hints and error names | 本轮未覆盖该差异。 |
| runtime-1-12 | low | 尚未对齐 | A function or Symbol result completes silently as null; an undefined result prints <result>null</result> | 本轮未覆盖该差异。 |
| runtime-1-14 | low | 尚未对齐 | Default and explicit labels differ: first line only, 48 characters, plus a '… [N more characters]' suffix | 本轮未覆盖该差异。 |
| runtime-1-18 | low | 保留差异 | An extra 4096-request cap per run kills the whole run with an error the script cannot catch | 见代码、PROGRESS.md和验收记录。 |
| runtime-1-19 | low | 保留差异 | log() and phase() events over 100 per second are dropped | 见代码、PROGRESS.md和验收记录。 |
| runtime-1-20 | low | 尚未对齐 | Nested-workflow messages: no remedy in the nesting error, no 'done' or 'failed' log | 本轮未覆盖该差异。 |
| resume-1-3 | low | 保留差异 | A resumed run shows up as a separate run, and the old run's card stays as it was | 见代码、PROGRESS.md和验收记录。 |
| resume-1-4 | low | 尚未对齐 | Cached calls lose the child agent's identity: no agentId, provider or model, so there is no transcript link | 本轮未覆盖该差异。 |
| resume-1-5 | low | 尚未对齐 | Journal line format differs from what Claude users are taught, and the plugin never says which line type holds the result | 本轮未覆盖该差异。 |
| resume-1-6 | low | 已处理 | A stopped or interrupted same-key call loses its slot, so on resume a later same-key result moves into its position | 见代码、PROGRESS.md和验收记录。 |
| resume-1-7 | low | 尚未对齐 | Resume is allowed while the stopped run's children may still be alive | 本轮未覆盖该差异。 |
| resume-1-8 | low | 尚未对齐 | The stop-before-resume error names the MCP tool even when the caller uses the CLI | 本轮未覆盖该差异。 |
| resume-1-9 | low | 尚未对齐 | Resume ownership is per launching agent and not stated in the tool text; refusals give no fallback | 本轮未覆盖该差异。 |
| resume-1-12 | low | 尚未对齐 | Cached calls skip the agent-cap and budget checks and do not count toward the cap | 本轮未覆盖该差异。 |
| children-1-4 | medium | 部分改善 | User request and assistant context are not relayed to children; no automated-trigger frame | 转述可取得的短用户消息；过长、缺失或仅代理消息的上下文可能不转述。 |
| children-1-6 | medium | 部分改善 | Children can start their own agents or workflows; the docs say they cannot | 移除子代的workflow入口并写入禁止再委派的说明；不是主机级禁止所有委派工具的沙箱。 |
| children-1-7 | medium | 已处理 | Children are not non-interactive: questions and plan approvals block the run indefinitely | 见代码、PROGRESS.md和验收记录。 |
| children-1-8 | medium | 部分改善 | agentType means a Paseo launch profile, not a persona; Claude custom agent types throw | 增加Explore/Plan、角色文件和inherit；角色frontmatter的模型/工具约束未模拟。 |
| children-1-9 | medium | 部分改善 | Model aliases, 'inherit' and bad-model semantics differ | 支持inherit及已有provider别名；不承诺所有Claude内部别名完全相同。 |
| children-1-10 | low | 尚未对齐 | Worktree note gives no paths and tells the child to commit; doc omits the retain case | 本轮未覆盖该差异。 |
| children-1-11 | low | 尚未对齐 | Child instructions and roles are lost on providers that ignore systemPrompt | 本轮未覆盖该差异。 |
| children-1-12 | low | 尚未对齐 | Effort: strict validation, and silent ignore when the model lacks the option | 本轮未覆盖该差异。 |
| children-1-13 | low | 部分改善 | No prompt-cache warm-up stagger, and per-call metadata comes first in the prompt | 见代码、PROGRESS.md和验收记录。 |
| children-1-14 | low | 尚未对齐 | Claude restriction options are silently ignored; other opts are validated more strictly | 本轮未覆盖该差异。 |
| children-1-16 | low | 已处理 | Child system prompt invites assumption notes into raw results | 见代码、PROGRESS.md和验收记录。 |
| notify-1-4 | medium | 部分改善 | <usage> uses different tag names and has no empty-result, done or tool-use counts | 见代码、PROGRESS.md和验收记录。 |
| notify-1-7 | low | 部分改善 | <failures> shows only the first 20 entries in a different line format, with no agent ids | 见代码、PROGRESS.md和验收记录。 |
| notify-1-8 | low | 尚未对齐 | Labels, errors and the summary are escaped lossily with ‹ › | 本轮未覆盖该差异。 |
| notify-1-9 | low | 尚未对齐 | A failed run's summary carries only the first line; the stack goes in a non-standard <error> tag, and nested-workflow failures lose every frame | 本轮未覆盖该差异。 |
| notify-1-10 | low | 已处理 | The recovery block has no pointer to child transcripts | 见代码、PROGRESS.md和验收记录。 |
| notify-1-11 | low | 尚未对齐 | <output-file> is only result.json; Claude's output file bundles summary, logs, progress and totals | 本轮未覆盖该差异。 |
| notify-1-12 | low | 尚未对齐 | Tag set and order differ from Claude's | 本轮未覆盖该差异。 |
| notify-1-15 | low | 尚未对齐 | The workflow_status result truncation reports the wrong remaining length | 本轮未覆盖该差异。 |
| notify-1-16 | low | 尚未对齐 | The stop tool says queued calls 'fail', but they are reported as skipped | 本轮未覆盖该差异。 |
| progress-1-2 | medium | 部分改善 | No live per-agent activity: no tool-call count, last tool, or idle indicator | 见代码、PROGRESS.md和验收记录。 |
| progress-1-4 | low | 尚未对齐 | Per-agent token counts stay at zero until a child's turn ends | 本轮未覆盖该差异。 |
| progress-1-6 | low | 尚未对齐 | No prompt preview for agents, so queued and cached agents show nothing about their task | 本轮未覆盖该差异。 |
| progress-1-7 | low | 尚未对齐 | No way to save a run's script as a named workflow from the UI | 本轮未覆盖该差异。 |
| progress-1-8 | low | 尚未对齐 | Declared phases match only on exact titles, leaving a stale empty phase | 本轮未覆盖该差异。 |
| progress-1-9 | low | 尚未对齐 | 'done' means different things in run totals and phase counts | 本轮未覆盖该差异。 |
| progress-1-10 | low | 尚未对齐 | Agent rows lack model, agent type, queue wait and a status filter | 本轮未覆盖该差异。 |
| progress-1-11 | low | 尚未对齐 | The child's task list (todo) is not shown | 本轮未覆盖该差异。 |

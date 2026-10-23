# Ultracode 与 workflow 用法验收

日期：2026-10-22（America/Los_Angeles）。主 daemon：Paseo 0.12.0，`srv_BSheQn5lzdEE`，`127.0.0.1:6767`，home `/Users/citrine/.paseo`。没有另起 daemon，也没有重启主 daemon。

## 交付内容

按 agent 的 Ultracode、规模建议、完整 authoring reference、五个原创内置 workflow，以及模式消息、三态核实、覆盖记录、恢复指引和安全 reload。实现审查的核实与完整性检查已恢复读取，最后汇总因额度失败，由接续任务归并已有结果；未重跑已完成的审查。

接续修复：`ccbbda6`、`3460fd3`、`135e6f6`、`a02b73a`、`a5851ab`、`2f80146`、`4975377`；文档同步 `5887b2f`。最终 runtime tree 为 `4975377`（含上述文档），23:28 PDT 通过 `scripts/safe-reload.mjs` 检查后 reload。随后 `plugin ls` 为 running，日志正常 ready；daemon 写出的五个内置脚本逐字等于 generated source，REFERENCE 也与源码一致。

完整回归：`npm run typecheck`、29 文件 / **288 测试**、`git diff --check` 通过。通知并发、回执不确定、cap/budget、缺失核实、最终阶段失败及 CLI 安全闸以隔离回归验证；没有用真实 daemon 模拟这些失败。

## 实机场景

Fixture repo：`/Users/citrine/plugin-test-2026-10-22-dwf-ultracode`，project `prj_5c3252cd4713dbf9`，workspace `wks_547c2be4bab6dfd3`。

| 场景 | 实测结果 | 截图 |
| --- | --- | --- |
| 规模设置保存、刷新 | medium 持久化到 settings 与 guidance.json；之后恢复 unrestricted | `2026-10-22-ultracode-settings-size-{desktop,compact}.png` |
| 按 agent 的两个开关 | 新 agent 默认关闭；开启 Ultracode 同时开启 workflow，刷新保留；模式 ON 消息到达 U | `2026-10-22-ultracode-panel-{off,on}-desktop.png` |
| Codex 工具发现 | gpt-6-luna 与 gpt-6-astra 初始看不到 MCP 描述；U Reload 后实际调用 workflow_reference 和 workflow | `2026-10-22-ultracode-codex-launches-deep-review-desktop.png` |
| 普通审查请求触发 workflow | U 没被要求使用 workflow，自行启动 deep-review；18 个子 agent 完成，独立核实并合并为三个真实缺陷 | `2026-10-22-ultracode-completed-{desktop,compact}.png` |
| 完成通知 | U 收到带 `<guidance>` 的结果，正确报告三个缺陷，没有启动无关的后续工作 | 持久证据目录中的 `U-final-transcript.txt` |
| 最新版本 UI / Reload | 新的必需 Reload 提示在桌面、420px 宽度显示；点击 U 的 Reload 成功，daemon 在 23:28:54 刷新同一完整 agent ID | `2026-10-22-ultracode-final-{desktop,compact}.png` |
| 最新版本 OFF | 关闭 U 的 workflow 同时关闭 Ultracode；新的 OFF 消息送达，U 回复 `Ultracode off.` 后 idle | `U-final-transcript.txt` |
| 清理后访问 | 原 workspace 页面显示 Workspace unavailable；插件面板不再可访问 | `2026-10-22-ultracode-cleanup-desktop.png` |

原始实机 run 为 `wf_2d04ea7bb729`，使用 Reload 时的 `94c656b` 代码，18/18 子调用完成、0 失败、33m45s，notified=true。植入缺陷是 note 路径穿越、1-based 分页偏移和最后不足一页被 floor 丢弃。每个缺陷都有独立核实及至少一次成功运行复现；另两次复现命令失败的 verifier 如实采用代码推演。六条 confirmed 记录代表三个缺陷，Plan 和 U 的最终回复已合并。

U 在 Ultracode=true 时显式传入 `size: small`，因此只有四个审查维度、每条两票、没有 gap critic。**本次不能证明 unrestricted 的完整深度已实机跑通。** 新版已把“不主动传小 size”放进模式消息、工具前部说明、reference 和内置用法；默认缩放由真实引擎的隔离测试覆盖。最终修复版未重跑这次 18-agent workflow。

Claude 2.1.291 的 transcript 已核对 alwaysLoad 和 MCP instructions 可见。没有实机穷尽所有 provider、list_changed 后的描述刷新、子 agent 的全部 MCP 配置、五个内置流程的所有深度或所有手机原生客户端。420px 截图来自真实 Web UI。

## 清理与证据

五个父 fixture：F0 `7b3578b0-e6c2-48b1-976c-dbc8060bbd13`、B `af28c02e-08b2-4609-9c72-954a293bb71a`、D `737eb08b-5ba4-40b1-8bc0-75b7c4f6e2e2`、U `5a53eb3e-e3c4-47da-98a1-339aa1d01377`、C `1b90ad7c-f461-4c76-bf56-116214f30da7`。全部先在 UI 关闭 access，再 archive；workspace 中的 18 个子 agent 也已归档。逐 ID 检查归档状态，project/workspace 不再出现在原生列表，fixture repo 与运行目录删除，access/outbox 没有 fixture 项。归档 nonce bindings 保留，不能再启动 workflow。旧的另一个 fixture `plugin-test-2026-10-22-dwf` 未被本轮清理。

持久证据与安装前备份：`/Users/citrine/.paseo/verification/dwf-ultracode-2026-10-22/`，包含原 settings/access/bindings/outbox、旧 shim、完整 run/journal/result、原审查最终输出、回归日志、U transcript 和 cleanup.json。临时 Chrome 已关闭。

测试失误：通知修复的两条首次红灯测试漏 mock reload helper，`agent reload a` 被 CLI 前缀解析成 **fixture B**，23:19:41/42 各刷新一次；daemon 日志确认未命中用户 agent。随后 helper 被统一 mock，安全脚本测试同时固定 PASEO_CLI/PASEO_BIN 为假 CLI。另一次 root 的旧 CLI 查找测试误走真实 CLI，但 `agent-from-daemon` 查找失败，未刷新任何目标；测试随后固定两个候选为假 CLI。

## 当前安装与恢复

daemon 保持 enabled/running，来源仍是目录 `/Users/citrine/Projects/flowly-kanban/usage-cecf/open-paseo-plugins/plugins/paseo-dynamic-workflow`。它是当前 workspace 的 worktree 路径，删除该 worktree 前必须切换到持久 checkout 或 Git 源。没有修改其他插件。

需要恢复旧版时，在另一个持久 checkout 取原版本 `fa7e41f`，先关闭相关 agent 的 Ultracode，在安全闸确认没有活动 run 后安装该 checkout 的插件目录，再 Reload 相关 agent。原目录来源和设置备份如上；旧 outbox/receipt 不能直接回放。新的安全闸与 Reload RPC 均有检查后到实际操作间的短暂竞态，未声称原子 idle-only。

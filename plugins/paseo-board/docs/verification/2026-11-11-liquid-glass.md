# 液态玻璃可选预设：隔离验证记录

2026-11-11（本地时间），分支 `sw/board-liquid-glass`，验证所用提交 `c5d83e277464a711513704e1c3f2c7fae1a52805`（基于 `origin/main` 4f88cd7）。用法与完整约定见[预设参考](../liquid-glass.md)。本轮没有安装插件、没有重载插件或重启 daemon，也没有创建、发布或删除任何 Board；全部是仓库自带的隔离 Chrome 测试。

## 自动化验收

按退出码逐步判定（脚本每步记录退出码后继续，不依赖 `a && b`）：

| 步骤 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | 通过 |
| `npx vitest run --maxWorkers=4 --exclude server/inbox-sync.test.ts` | 0 | 53 个文件 809 项 |
| `npx vitest run server/inbox-sync.test.ts --maxWorkers=1` | 0 | 10 项 |
| `npm run test:browser` | 0 | 139 项（原有 118 项 + 液态玻璃 21 项） |
| `npm run test:host` | 0 | 41 项（含液态玻璃 3 项） |
| `npm run test:release` | 0 | 32 项（含液态玻璃 2 项） |
| `npm run test:release-host` | 0 | 38 项 |
| `build:client`、`build:worker` 两次 | 0 | 两次 sha256 相同，且与已提交字节一致；`build:app` 输入未变 |

- 没有标记的画板：文档与 4f88cd7 的模板冻结副本逐字节一致（单元测试），并用同一脚本在只读参考目录和本分支分别生成文档与发布页摘要，结果完全相同；内联旧版 0.2 kit 的预览 Board 源码（`demo.html`）同样逐字节不变。
- 浏览器检查覆盖：真实 `buildBoardDocument` 外壳与 `CanvasFrame` 中六种交互加图表，在浅色 1100、深色 1100、浅色 480、浅色 360 各走一遍；`/` 转发的范围、焦点归还与失败兜底；Board 运行时占用 Esc 时一次关闭；实时补丁首次加入标记后只重建一次且阅读位置误差 ≤ 4px、编辑输入框期间不重建；旧 kit 实时加入后接管；减少动态效果；布局偏移为 0；KPI 文字评论引用真实数值并成功截图。

## 一次失败及处理

第一轮全套里 `test:browser` 退出码 1：原有用例在重新挂载后右键 `#bound-content` 没有打开评论框。同一命令在只读参考目录通过（118 项），说明由本分支引起。原因是测试宿主为“Board 自己的工具栏”加的按钮占了一行，使宿主页出现滚动。改为可聚焦但不占位的屏外按钮后，全套重跑全部为 0。

## 未覆盖

真实 Paseo 应用（Electron 焦点、agent/工作区面板、终端与输入框旁的 `/`、⌘K）未验证，需要用户批准后按[预设参考](../liquid-glass.md#verification)中的手工清单检查。截图见验证目录 `glass-shots/`。

## 评审问题修复（第二轮）

修复后在提交 `6a1a4f4a55c91d64596046b0bcb63658e770afe7` 上重跑全套，每步退出码均为 0：TypeScript；单元 53 个文件 817 项与 inbox-sync 10 项；画布浏览器 152 项（液态玻璃 34 项，新增 13 项回归检查）；宿主 41 项；发布页 32 项；发布宿主 38 项；`build:client`、`build:worker` 两次 sha256 相同且与已提交字节一致；`build:app` 输入未变。修复内容和逐项证据见验证目录 `FIX-GLASS.md`，截图在 `glass-shots/`。真实 Paseo 应用仍未验证。

## 真实应用验收后的修复（第三轮，2026-11-12）

合并版本在真实 Paseo（1440×900，Board 区域约 950×787）验收时发现两个问题，本轮只在仓库隔离环境里修复和验证，没有安装、重载插件或重启 daemon，没有创建、发布或删除 Board。

1. **展开模块后缩略条被停靠栏完全挡住**（缩略条 y 716–770，停靠栏 y 705–769，三个缩略按钮点到的都是停靠栏）。原因：把模块和缩略条滚进视野的那一下发生在展开动画开始时，页面还是旧高度，浏览器把滚动截短了；而停靠栏一直浮在最上层。修复：动画结束后按最终布局再滚一次（减少动态效果时也会滚）；任何宽度下，模块展开期间停靠栏只要会挡住展开的模块或缩略条就让开，挪开后回来；键盘焦点在停靠栏时保留，鼠标点过的焦点不算。新检查在旧代码上失败，数值与真实应用一致（缩略条 717–771 在停靠栏 705–769 之下，y 442/580）。
2. **缩放窗口时 Board 顶部出现「ResizeObserver loop completed with undelivered notifications.」**（新预设 Board 和旧 0.2 kit Board 都有）。这是浏览器的无害提示。修复：所有 Board 的画布运行时不再上报它（以及旧写法「ResizeObserver loop limit exceeded」），补丁脚本运行期间出现它也不再判补丁失败（旧代码会让后续补丁全部暂停）；Paseo 收到框架自己发来的这类提示也会丢弃；预设自己的尺寸监听改到下一帧写布局。真实错误和未处理的拒绝仍会上报，宿主里仍显示提示条。没有标记的 Board 文档只多了这处运行时改动：把它撤掉，文档摘要与 4f88cd7 完全一致（单元测试）。

另外补完了被中断的真实应用检查（隔离环境）：深色 Paseo 主题下作用域内全部采样颜色与浅色相同，宿主自己的颜色变量确实是深色；真实的 0.2 预览 Board 源码（`BOARD_LEGACY_BOARD_HTML`，不在仓库里）只由旧 kit 运行，命令面板、停靠栏放大与跳转、缩放都正常，缩放中旧 kit 自己触发了 4 次该提示，没有一次传到 Paseo。

在提交 `37c160f6d5c4c8a8a1b1b3b46b9e7fd48e1c8e3b` 上按退出码逐步判定，全部为 0：

| 步骤 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | 通过 |
| `npx vitest run --maxWorkers=4 --exclude server/inbox-sync.test.ts` | 0 | 53 个文件 818 项 |
| `npx vitest run server/inbox-sync.test.ts --maxWorkers=1` | 0 | 10 项 |
| `npm run test:browser` | 0 | 156 项（液态玻璃 38 项，本轮新增 4 项） |
| `npm run test:host` | 0 | 42 项（新增缩放不出提示条、真实错误仍提示） |
| `npm run test:release` | 0 | 32 项 |
| `npm run test:release-host` | 0 | 38 项 |
| 真实 0.2 Board（`BOARD_BROWSER_SCOPE=glass`） | 0 | 39 项 |
| `build:client`、`build:worker` 两次 | 0 | 两次 sha256 相同，且与已提交字节一致；`build:app` 输入未变 |

日志、截图和旧代码上的失败记录见验证目录 `fix-realapp/`。真实 Paseo 应用里的复查需要用户批准重新安装后进行（[预设参考](../liquid-glass.md#verification)手工清单第 4、5 条）。

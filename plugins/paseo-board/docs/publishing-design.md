# Board 固定版本发布设计研究

日期：2026-10-31。研究基线：`c133366b697d479a5b2b2f8b20636727496f565c`。用户先选择「固定版本」，随后明确要求实现通用导出和 GitHub Pages。实现正在本机验证；没有创建真实远程仓库、PR、合并或公开发布任何 Board。以下描述当前代码契约；最终验收结果以本次 verification 回执为准。

## 本次实现与使用

`server/static-release.ts` 将指定 canvasBase 的最终 authored HTML 与显式 publicData 固定成发布版本；默认公共数据为界面里明确展示的空对象。来源 Board ID、revision 和 canvasBase 只保存在本机 provenance。公共包含 `index.html`、`release.json`、`NOTICE` 与 `LICENSE-APACHE-2.0`，不复制 discussion、decision、patch history、作者 userState 或草稿。相同来源版本、内容和配置得到同一发布 ID 与同字节 ZIP；来源后续变化不修改已生成的版本。

独立 viewer 保留任意内联 HTML/CSS/JS、SVG/Canvas 和本地表单处理。它在隔离 iframe 中提供固定 `board.getData/watch/onData`、访客本地 `getState/saveState/onState` 和明确取消的 `ask`；没有 Paseo SDK、编辑器或 agent 通道。静态源码重放无法重建历史 JS heap，必须检查实际冷启动预览。浏览器本地状态按发布 ID 和站点路径隔离，大小上限 512 KiB；禁用本地存储时给出提示并保留本次页面状态。

第一期联网模式是**离线内嵌资源**与**已批准的四个 CDN**，没有自动下载/打包远程库。离线模式要求图片/字体等已在源码内嵌（如 data URL）；外部 CDN 或未打包的相对资源会明确拒绝。CDN 模式仅允许 unpkg、jsDelivr、esm.sh 和 cdnjs，与工作 Board 当前策略一致。源码中算出来的地址不能完全静态枚举，浏览器策略仍阻止范围外的请求；用户主动点击普通网页链接不算离线依赖。单个导出包上限 8 MiB。

仓库命令（开发环境先 `npm ci`；安装后的插件通过编译后的 host RPC 使用，不依赖运行时 esbuild）：

```sh
node scripts/board-release.mjs export --board /path/board-read.json --public-data /path/public.json --out /path/new-public-directory --zip /path/new-public.zip --store /path/private-releases
node scripts/board-release.mjs serve --store /path/private-releases --release release-<sha256>
node scripts/board-release.mjs --help
```

导出只创建新目录/新 ZIP，不覆盖既有文件；`serve` 只绑定 `127.0.0.1`。将公开目录交给用户自己的 Caddy/Nginx 即可提供公网、内网或 VPN 站点，不需要安装 Paseo。若省略 `--store`，本次 CLI 使用临时私有存储并在导出结束后清理；要继续 GitHub 发布请显式保留 store。`board-read.json` 可为完整 Board 或 `{board: ...}`，这份私有输入文件不会复制到公开目录。

`server/github-pages.ts` 通过本机 `gh` 已登录身份取得选定账号凭据，不切换全局活跃账号，凭据不进入浏览器、文件包或 job。选择已有仓库，或显式选择创建 public/private 新仓库；公开分支从 PR 阶段起就会暴露提交文件。私有仓库不保证 Pages 私密，Pages 套餐/权限仍由 GitHub 执行。

准备阶段固定 artifactHash、账号、仓库、eventId 和 PR head；同事件重试会复用远程分支/PR。公开文件放在 `paseo-board-publication/site`，workflow 不执行作者网页 JS 或任意构建命令，仅校验文件 hash。合并前要求同一 head 的发布 PR 检查成功，并再次拒绝 head/base 改动、未知 Pages 归属和冲突工作流；正常已有仓库文件保持不变。没有绕过分支保护。合并、部署成功都不直接标为上线：读取标准 `https://<owner>.github.io` 地址上的完整 manifest 和每个公开文件，字节都符合该版本才返回 `live`。

明确的第一期限制：自定义域名尚不自动核验（任务保留部署中状态）；Pages 初次配置请求若结果不明且远程已出现站点，本地“曾发过请求”不作为归属证据，禁止盲目接管，需要核对当前站点后恢复；现有空仓库需要先初始化，显式新建仓库会初始化；额外托管适配器、SSH 自动上传、远程库 vendoring、公开实时后端不在本次实现内。所有 GitHub 状态机测试使用明确的本地 transport，不能替代真实账户/远程 Pages 验收。


## 编辑副本、发布版本、部署记录

- **编辑副本**仍是普通 Board：从精确 canvasBase 物化当前源码，复制 data，生成独立 Board ID；保留 owner/project/workspace 关联，便于继续和 agent 交流和手动修改。副本清空讨论、决策、事件、历史补丁和作者 userState。相同 copy event 重试取回已有副本，不能覆盖用户后来修改的副本。来源关系保存在本机私有复制回执。
- **发布版本**是不可变的网页、公共数据和 viewer 配置。可以从工作 Board 直接生成，也可以先复制再编辑。生成时要求源画布版本匹配；生成后不再跟随源 Board，也不因源 Board 删除而失去导出能力。发布 ID 对来源身份、canvasBase、内容和 viewer 代码取 hash，公开产物不包含原始 Board ID。
- **部署记录**保存 releaseId、artifactHash、账号、仓库、immutable eventId、冻结分支/head、PR、merge 和部署核验状态。当前没有独立 PublishTarget 管理或专门回退按钮；可选旧快照创建新的发布请求，重新发布旧内容。凭证不会持久化到部署记录。

页面入口为「更多 → 导出与发布」：先选或制作发布副本，编辑；生成固定版本，查看公共数据与联网依赖；预览/下载同一份产物；选择 GitHub 账号和仓库，明确创建 PR；查看固定提交后点击合并发布；刷新核对部署。创建 PR 已是远程上传，不能把“还没合并”当作内容仍然私密。此功能的发布动作不涉及插件自身 PR #4，也不授权合并插件 main。

## Viewer 兼容范围

| 接口/行为 | 当前固定版本 |
| --- | --- |
| `board.getData()` | 返回显式公共数据的副本；不自动使用整份 canvas.data |
| `watch(path, fn, options)` | JSON Pointer、首次同步回调、可取消订阅；固定数据没有远程更新 |
| `onData(fn)` | 可订阅，但没有宿主 feed |
| `getState()` / `restoreState()` | 当前访客此版本本地状态；首次为空对象 |
| `saveState()` / `onState()` | 更新本页状态并尝试写访客本地存储，订阅者获得副本 |
| `ask()` / `openai.sendFollowUpMessage()` | 立即返回取消并提示不连接 agent，不悬挂、不偷偷发消息 |
| `onReveal()` | 可注册/取消；没有私人讨论定位事件 |
| `getContext()` | 公开 releaseId 与固定版本信息，没有原 Board/host/agent ID |
| HTML/CSS/JS、SVG/Canvas、表单事件 | 保留作者代码；表单可运行本地 handler，不获网络导航权限 |
| 源码中已有链接 | 用户主动点击 http(s) 链接可在独立窗口打开；隔离页面不能读取父窗口状态 |

原位文字、复制移动组件等持久编辑会先由 `describeAuthoring` 重放成最终源码。重放失败则拒绝导出，不回退到旧 base 或偷偷携带历史 patch journal。旧 base 中已经被替换/删除的私人内容不应出现在包里。任何主动保留在最终 HTML 或 publicData 内的私密内容仍需用户检查；系统不会靠字段黑名单假装所有自由代码都已脱敏。

冷启动不是冻结运行时：动态生成且未写回源码的节点、闭包、计时器当前值、媒体位置、依赖历史脚本执行次序的行为不保证保留。应在发布副本中整理成能从零打开的页面，再检查独立预览。访客存储不是共享后台；不同设备、浏览器和版本不会自动同步。

## GitHub 状态与恢复

`prepared → pr-open → merged → deploying → live`，另有 `failed/unknown` 表示明确失败或暂时无法核对。

准备时先存本机 job 再发远程请求；分支和 PR 返回丢失后按原 eventId 查找，不创建重复 PR。不同内容、账号或仓库不能重用原 eventId。PR head/base 一旦变化就拒绝代为合并。PR 自带校验仅读取公开产物并核对 hash，不运行网页脚本；同一 head 的校验完成且成功后才能调用 merge，仓库额外 required checks/保护仍由 GitHub 执行。

已存在无归属记录的 Pages 站点、占用发布目录、被改动的本工具 workflow、其他 Pages workflow 都会阻止接管。归属文件的 hash 必须同时符合当前生成的已知 workflow，不能只信文件自报的 hash。首次配置 Pages 响应丢失后，即使远程出现站点也不能推定归属；保留待核对状态，避免把并发创建的别人的站点覆盖掉。已确认配置后的 merge 返回丢失，可以查询同一 PR 的真实 merged SHA 继续核对。

部署核对必须符合合并 SHA、目标分支和 push/workflow_dispatch 事件；Actions 成功后仍逐文件读取站点，完整 manifest、HTML、署名与许可均须匹配。URL 不匹配/旧缓存/文件改动不会标成 live。未启用 Pages、配额、权限、required checks 或平台失败会显示真实错误，不能用“PR 已创建”代替上线成功。

本机 CLI 兼容旧版无 `gh auth status --json` 的 `gh`，只提取登录用户名和活跃状态；不显示完整 auth 输出，不输出 token。实际 API 取选定账号 token；不切换其他终端使用的全局账号。

## 自有服务器与后续托管

| 方式 | 当前能力 | 边界 |
| --- | --- | --- |
| 自有公网/内网服务器 | 下载 ZIP/目录，自行交给 Caddy/Nginx；无需 Paseo 后台 | TLS、认证、IP 可达性由现有服务器负责；没有 SSH 自动上传 |
| GitHub Pages | 选择账号/仓库，PR，固定提交合并，Actions，标准 Pages URL 与产物核验 | 常规网站公网；私有仓库不等于私有网站；自定义域名核验待做 |
| Cloudflare 等 | 通用静态包可手工上传 | 后续可增加 adapter；当前没有账户绑定、自动部署或 Access 配置 |

GitHub Pages 是静态托管：不会运行服务器 PHP/Python/Ruby。Free 支持公开仓库，私有仓库按 Pro/Team/Enterprise 权限决定；普通 Pages 即使源仓库私有也可能公开。[GitHub 建站说明](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。私有 Pages 访问控制有 Enterprise Cloud 组织条件。[访问控制](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site)。

工作流使用 GitHub 官方 Pages Actions 与最低部署权限；创建 Pages 设置另需对应管理权限。[自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Pages API](https://docs.github.com/en/rest/pages/pages)。本站导出限额 8 MiB 与 GitHub 平台自己的容量/频率/用途限制是不同的限制。[GitHub Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)。

自有服务可用 [Caddy 静态目录](https://caddyserver.com/docs/quick-starts/static-files)。后续托管优先考虑 [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)；若用 Pages Direct Upload，创建后不能直接转换为 Git integration 项目。[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)。任何未来的私密分享都需覆盖所有生产/预览域名的真实访问控制，不能以难猜 URL 代替认证。

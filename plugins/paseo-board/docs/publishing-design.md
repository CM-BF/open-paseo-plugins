# Board 固定版本发布设计研究

初版日期：2026-10-31；一键发布修订：2026-11-01；Enterprise 修订：2026-11-08。用户先选择固定版本，随后要求通用导出、GitHub Pages，以及一次点击自动完成发布。以下描述实现契约；真实远程验收结果另见验证记录，不以本地适配测试代替。

## 本次实现与使用

`server/static-release.ts` 将指定 canvasBase 的最终 authored HTML 与显式 publicData 固定成发布版本；默认公共数据为界面里明确展示的空对象。来源 Board ID、revision 和 canvasBase 只保存在本机 provenance。公共包含 `index.html`、`release.json`、`NOTICE` 与 `LICENSE-APACHE-2.0`，不复制 discussion、decision、patch history、作者 userState 或草稿。相同来源版本、内容和配置得到同一发布 ID 与同字节 ZIP；来源后续变化不修改已生成的版本。

独立 viewer 保留任意内联 HTML/CSS/JS、SVG/Canvas 和本地表单处理。它在隔离 iframe 中提供固定 `board.getData/watch/onData`、访客本地 `getState/saveState/onState` 和明确取消的 `ask`；没有 Paseo SDK、编辑器或 agent 通道。静态源码重放无法重建历史 JS heap，必须检查实际冷启动预览。浏览器本地状态按发布 ID 和站点路径隔离，大小上限 512 KiB；禁用本地存储时给出提示并保留本次页面状态。

第一期联网模式是**离线内嵌资源**与**已批准的四个 CDN**，没有自动下载/打包远程库。离线模式要求图片/字体等已在源码内嵌（如 data URL）；外部 CDN 或未打包的相对资源会明确拒绝。CDN 模式仅允许 unpkg、jsDelivr、esm.sh 和 cdnjs，与工作 Board 当前策略一致。源码中算出来的地址不能完全静态枚举，浏览器策略仍阻止范围外的请求；用户主动点击普通网页链接不算离线依赖。单个导出包上限 8 MiB。

仓库命令（开发环境先 `npm ci`；安装后的插件通过编译后的 host RPC 使用，不依赖运行时 esbuild）：

```sh
node scripts/board-release.mjs export --board /path/board-read.json --public-data /path/public.json --out /path/new-public-directory --zip /path/new-public.zip --store /path/private-releases
node scripts/board-release.mjs serve --store /path/private-releases --release release-<sha256>
node scripts/board-release.mjs accounts --github-host github.enterprise.example
node scripts/board-release.mjs repositories --github-host github.enterprise.example --account employee
node scripts/board-release.mjs --help
```

导出只创建新目录/新 ZIP，不覆盖既有文件；`serve` 只绑定 `127.0.0.1`。将公开目录交给用户自己的 Caddy/Nginx 即可提供公网、内网或 VPN 站点，不需要安装 Paseo。若省略 `--store`，本次 CLI 使用临时私有存储并在导出结束后清理；要继续 GitHub 发布请显式保留 store。`board-read.json` 可为完整 Board 或 `{board: ...}`，这份私有输入文件不会复制到公开目录。

`server/github-pages.ts` 通过本机 `gh` 已登录身份取得选定账号凭据，不切换全局活跃账号，凭据不进入浏览器、文件包或 job。选择已有仓库，或显式选择创建 public/private 新仓库；公开分支从 PR 阶段起就会暴露提交文件。私有仓库不保证 Pages 私密，Pages 套餐/权限仍由 GitHub 执行。

准备阶段固定 artifactHash、GitHub 主机、账号、仓库、eventId 和 PR head；同事件重试复用远程分支/PR，不允许把同一请求切换到另一台 GitHub。旧记录未含主机时继续按 github.com 解释。公共 GitHub 独立站点继续使用 `paseo-board-publication/site` 与受验证的 Pages workflow。GHES 新站点使用专用仓库的 `/docs` 分支发布：检查该目录原先为空，合并后核对完整待公开文件再启用 Pages，不引入外部 Actions。已有分支式 Pages 沿用原 source branch 和 `/` 或 `/docs`，在专属版本目录加入文件，不替换首页、其他页面或 Pages 配置。合并前检查真实 Git tree、完整文件差异和固定 head；workflow 模式还要求对应提交的发布检查成功。所有模式保留仓库原有检查与分支保护。

部署地址使用已认证 GitHub API 返回的 `html_url`，支持内部 Pages 与自定义 HTTPS 域名。核对网站时不发送 GitHub token、不跟随登录重定向。对应合并提交的构建成功后提供部署链接；需要公司登录的站点会显示“内容待核验”。只有逐文件读取到 manifest、HTML、署名及许可文件的精确字节才返回 `live`，部署成功本身不能代替内容核验。

明确的限制：Pages 初次配置请求若结果不明且远程已出现站点，本地“曾发过请求”不作为归属证据，禁止盲目接管，需要核对当前站点后恢复；现有空仓库需要先初始化，显式新建仓库会初始化。GHES 已有其他发布方式不会被自动切换；企业禁止 Pages、缺少权限或站点需登录时显示实际状态。额外托管适配器、SSH 自动上传、远程库 vendoring、共享应用后端仍属于后续设计。所有 GitHub 状态机测试使用明确的本地 transport，不能替代真实公司服务器发布验收。


## 编辑副本、发布版本、部署记录

- **编辑副本**仍是普通 Board：从精确 canvasBase 物化当前源码，复制 data，生成独立 Board ID；保留 owner/project/workspace 关联，便于继续和 agent 交流和手动修改。副本清空讨论、决策、事件、历史补丁和作者 userState。相同 copy event 重试取回已有副本，不能覆盖用户后来修改的副本。来源关系保存在本机私有复制回执。
- **发布版本**是不可变的网页、公共数据和 viewer 配置。可以从工作 Board 直接生成，也可以先复制再编辑。生成时要求源画布版本匹配；生成后不再跟随源 Board，也不因源 Board 删除而失去导出能力。发布 ID 对来源身份、canvasBase、内容和 viewer 代码取 hash，公开产物不包含原始 Board ID。
- **部署记录**保存 releaseId、artifactHash、GitHub 主机、账号、仓库、immutable eventId、冻结分支/head、PR、merge 和部署核验状态。分享链接按 Board、主机、仓库和 key 成组，后续版本更新同一链接，见[分享页更新验收](verification/2026-11-10-share-updates.md)；没有专门回退按钮，分享链接只向前更新。凭证不会持久化到部署记录。

页面入口为「更多 → 导出与发布」：按需复制编辑，生成固定版本并查看预览；选择 GitHub 主机、账号和仓库后点击「一键发布」。这一次操作授权服务器完成 PR、验证、固定提交合并、部署与站点核对，无需另点合并。面板显示进度和链接，关闭面板或刷新不终止已经授权的任务。选择历史任务会填回其固定主机、账号和仓库；明确重试沿用同一请求。创建 PR 已是远程上传，不能把“还没合并”当作内容仍然私密。此功能的发布动作不授权合并插件自身的 PR 或 main。

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

一键发布先持久化该请求的自动推进授权，再由服务器执行。自动推进有 30 分钟窗口；超时或明确失败后可点击继续，沿用原请求而非另建 PR。启动时恢复尚有效的任务；没有活动任务时不持续轮询。旧的 prepare-only 记录不会因重开界面升级授权。

准备时先存本机 job 再发远程请求；分支和 PR 返回丢失后按原 eventId 查找，不创建重复 PR。不同内容、GitHub 主机、账号或仓库不能重用原 eventId。PR head/base 一旦变化就拒绝代为合并。PR 自带校验仅读取公开产物并核对 hash，不运行网页脚本；同一 head 的校验完成且成功后才能调用 merge，仓库额外 required checks/保护仍由 GitHub 执行。

已有分支式 Pages 允许在未占用的版本子目录发布，原 source 和配置需保持一致；它不需要把整个站点改成本工具的工作流。已有不受本工具管理的 Actions Pages、占用发布目录、被改动的本工具 workflow 或冲突工作流仍拒绝接管。归属文件的 hash 必须同时符合当前生成的已知 workflow，不能只信文件自报的 hash。首次配置 Pages 响应丢失后，即使远程出现站点也不能推定归属；保留待核对状态，避免把并发创建的别人的站点覆盖掉。已确认配置后的 merge 返回丢失，可以查询同一 PR 的真实 merged SHA 继续核对。

部署核对必须符合合并 SHA：workflow 模式检查目标分支的 push/workflow_dispatch run；分支式 Pages 检查对应 Pages build。成功后仍逐文件读取站点，完整 manifest、HTML、署名与许可均须匹配。URL 不匹配/旧缓存/文件改动不会标成 live。未启用 Pages、配额、权限、required checks 或平台失败会显示真实错误，不能用“PR 已创建”代替上线成功。

### 固定分享链接（分享系列）

带 `shareKey` 的请求属于一个分享系列：同一 GitHub 主机、仓库和 key，且发布版本的私有来源属于同一张 Board（boardId，有记录时再比 Board 创建时间）。没有 `shareKey` 的旧请求和旧记录行为不变。

- 目录：分支式 Pages 的固定链接是 `boards/<key>/`，每个版本另存 `boards/<key>/v/<releaseHex>/`（`/docs` 源加 `docs/` 前缀）。`url/deployedUrl` 指此版本，`shareDeployedUrl/shareUrl` 指固定链接。workflow 模式固定链接就是 Pages 根目录，不在线存档旧版本，生成的 workflow 文本不变。
- 接管旧链接：key 为旧发布的 64 位 hex 时，沿用该旧任务的 `boards/<hex>/` 作为固定目录（`adoptedFrom`），同一个 PR 把原版本另存到 `boards/<hex>/v/<hex>/`；旧任务之后在该存档地址核对，不会被降级。
- 归属：固定目录只比直接文件（忽略 `v/`），须为空，或与本 Board 在该仓库任一已到 headSha 的任务的版本逐字节相同；拒绝前先刷新有 PR 但未记录合并的系列任务。workflow 根目录同理，须为空或属于本 Board 的版本。版本存档目录须为空或与该版本逐字节相同。文件集合不同时拒绝，不删文件。
- 只前进：准备和合并时，若同系列有更晚创建且已到 headSha 的任务，或固定目录里已是来源更新的版本（documentVersion、patchCount、canvas revision 依次比较），拒绝覆盖。重新授权旧的失败或超时请求同样适用。
- 进行中：同系列另一请求尚未合并且仍在自动推进窗口内时，`publish` 拒绝新建或重新授权（系列锁内检查；锁顺序始终先系列后任务；锁按主机+仓库）。已合并、部署中或需登录核验的不阻塞。窗口到期时保留“需要公司网络或登录”的核验提示。
- 无改动：新版本文件与基线完全相同时不建分支和 PR，任务记为 `refusal: up-to-date`、状态 `deploying`，随后由 refresh 只做逐字节核对（通过后为 `live`）。这个状态与普通已合并任务的核对方式一致，且不会占用系列。
- 发布方式不能在系列内切换（分支目录 / workflow）。拒绝写在任务的 `refusal {code, message}`（series-busy、newer-on-share、share-foreign、share-files-mismatch、up-to-date），客户端据此删除过时的待发请求。
- 刷新：只由系列中最新上线的任务核对固定链接；更早的版本只核对自身存档，不因固定链接已更新而降级。暂时错误不会清掉已知的 `shareDeployedUrl`。

本机 CLI 兼容旧版无 `gh auth status --json` 的 `gh`，只提取登录用户名和活跃状态；不显示完整 auth 输出，不输出 token。实际 API 取选定账号 token；不切换其他终端使用的全局账号。

## 自有服务器与后续托管

| 方式 | 当前能力 | 边界 |
| --- | --- | --- |
| 自有公网/内网服务器 | 下载 ZIP/目录，自行交给 Caddy/Nginx；无需 Paseo 后台 | TLS、认证、IP 可达性由现有服务器负责；没有 SSH 自动上传 |
| GitHub Pages（公共与企业） | 选择主机/账号/仓库后一次点击，自动 PR、固定提交合并、部署与 URL 产物核验；已有分支站点使用版本子目录 | 网站访问权限由目标 GitHub 配置；需登录的站点提供待核验链接，不冒充字节已核验 |
| Cloudflare 等 | 通用静态包可手工上传 | 后续可增加 adapter；当前没有账户绑定、自动部署或 Access 配置 |

GitHub Pages 是静态托管：不会运行服务器 PHP/Python/Ruby。Free 支持公开仓库，私有仓库按 Pro/Team/Enterprise 权限决定；普通 Pages 即使源仓库私有也可能公开。[GitHub 建站说明](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。私有 Pages 访问控制有 Enterprise Cloud 组织条件。[访问控制](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site)。

工作流使用 GitHub 官方 Pages Actions 与最低部署权限；创建 Pages 设置另需对应管理权限。[自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Pages API](https://docs.github.com/en/rest/pages/pages)。本站导出限额 8 MiB 与 GitHub 平台自己的容量/频率/用途限制是不同的限制。[GitHub Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)。

GitHub Enterprise Server 使用 `https://<host>/api/v3`；GitHub Enterprise Cloud 的 `*.ghe.com` 使用对应 `api.<host>`。所选主机和用户均传给 `gh auth token`，不借用公共 GitHub token。[GHES REST 文档](https://docs.github.com/en/enterprise-server@latest/rest/using-the-rest-api/getting-started-with-the-rest-api)。GHES 不支持当前 `deploy-pages@v4`，因此新站点走分支发布，不自动上传不兼容的 Actions 工作流。[官方兼容表](https://github.com/actions/deploy-pages#compatibility)。

自有服务可用 [Caddy 静态目录](https://caddyserver.com/docs/quick-starts/static-files)。后续托管优先考虑 [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)；若用 Pages Direct Upload，创建后不能直接转换为 Git integration 项目。[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)。任何未来的私密分享都需覆盖所有生产/预览域名的真实访问控制，不能以难猜 URL 代替认证。

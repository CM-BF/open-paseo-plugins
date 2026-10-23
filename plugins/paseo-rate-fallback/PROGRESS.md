# paseo-rate-fallback：进度记录

## 目标与设计

按每个会话记录原模型与思考档位。Claude 限流时，用 Paseo 原生 fork 上下文在同一工作区创建 GPT-6.1 Sol Ultra 备用会话；额度恢复且双方空闲后，把最新进展交回保留的原 Claude 会话。Codex 会话使用原地模型切换。

- 保留原 Claude 会话，避免丢失其提供商配置、权限模式和内部状态；跨提供商传递的是对话快照，共享的是工作区文件。
- 用持久创建键、归属标签与发送消息 ID 恢复创建或发送响应丢失的场景，避免重复会话与重复续跑。
- 发送前重新检查双方是否空闲、归档或手动改动；用户取消或接管时停止自动交接。
- 区分共享额度和模型专属额度。未知重置时间时每五分钟检查，备用会话失败时停止重复发送。

## 子任务状态

- [x] Codex 原地切换及原设置恢复。
- [x] Claude 限流识别、时区重置时间与模型专属额度解析。
- [x] Claude → GPT 的原生 fork、双向上下文交接和重载恢复。
- [x] 设置页、会话打开按钮和原生时间线交接卡片。
- [x] 类型检查、206 项单测及所服务客户端包的 Hermes 检查。
- [x] 主 daemon 实机创建会话、模型切换及一次真实 GPT 消息传输。
- [ ] 真实 Web UI 的桌面和窄屏截图：电脑控制与 Paseo 浏览器调用超时，尚未完成视觉验收。
- [ ] 实际耗尽 Claude 额度再等待真实重置的完整验收：限流、恢复与 Claude 回传发送采用模拟验证。

## 验证记录

2026-10-22，Paseo 0.12.0，主 daemon `srv_BSheQn5lzdEE`，home `~/.paseo`，listen `127.0.0.1:6767`。实现基线为本地提交 `7d96d31`，远端同内容移植提交 `6d772f3`。详细场景、测试会话 ID 和清理结果见 [VERIFICATION.md](VERIFICATION.md)。

- `npm run typecheck` 和 `npm test`：通过，六个测试文件共 206 项；推送前已复查。
- 同一工作区的真实 Claude 与 GPT 子会话创建、原生 fork 附件双向传递：通过，原 Claude 的 opus/high/plan 配置保持不变。
- GPT-6.1 Sol Ultra 带原生附件的真实请求：回复 `PASEO_FORK_TRANSPORT_OK`，返回快照包含该回复；测试会话、工作区、项目登记和临时文件已清理。
- 客户端包：Hermes 检查通过。没有可交付的真实 UI 截图，未宣称视觉验收通过。

## 安装与发布状态

主 daemon 当前使用稳定目录源 `/Users/citrine/Projects/Paseo/plugins/paseo-rate-fallback`，插件 ID 为 `paseo-rate-fallback`，状态 running。发布只移动 Git 内容，不替换 daemon 安装源；临时发布检出删除后不影响运行。变更前状态备份位于 `~/.paseo/backups/paseo-rate-fallback-before-fork-20261022/`。

发布目标为 `CM-BF/open-paseo-plugins` 的 `main`，目录 `plugins/paseo-rate-fallback/`。本机 `Projects/Paseo` 是独立初始化的安装目录，与远端历史不同；发布时从远端 main 移植本插件改动，保留远端已有提交。

后续优先完成真实 Web UI 桌面/窄屏验收，再做受控的 Claude 限流与真实回传验证。支持范围为 Claude 和 Codex，会话内部状态不跨提供商迁移。

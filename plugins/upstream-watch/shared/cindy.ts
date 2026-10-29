import { reviewSchema, type WatchDraft } from "./contracts";

/** Conservative starting inventory; adoption is an editable assessment, never a parity guarantee. */
export const cindyReview = reviewSchema.parse({
  mode: "recommend-only",
  features: [
    {
      id: "presets",
      title: "伙伴预设与创建",
      adoption: "partial",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots",
        "apps/desktop/src/main/maker-ipc/botProfileFolder.ts",
      ],
      localPaths: ["shared/presets.ts", "server/presets"],
      notes: "已接入预设与创建；逐项核对预设字段、技能及导入边界。",
    },
    {
      id: "groups",
      title: "群聊、单发言人队列与任务派工",
      adoption: "partial",
      upstreamPaths: [
        "apps/desktop/src/main/maker-ipc/botGroupChatService.ts",
        "apps/desktop/src/main/maker-ipc/botTaskCoordination.ts",
        "apps/desktop/src/main/maker-ipc/botDelegationService.ts",
      ],
      localPaths: ["shared/groups.ts", "server/group-driver.ts"],
      notes: "实现与验收仍在推进；核对逐伙伴独立会话、停止、恢复和派工语义。",
    },
    {
      id: "identity-memory",
      title: "人格、长期记忆与复盘",
      adoption: "partial",
      upstreamPaths: [
        "apps/desktop/src/main/maker-ipc/botProfileRuntime.ts",
        "apps/desktop/src/main/maker-ipc/botMemoryService.ts",
        "apps/desktop/src/main/maker-ipc/botNightlyLearning.ts",
        "packages/maker-core/src/memory",
      ],
      localPaths: ["server/runtime.ts", "server/memory.ts", "server/mcp.ts"],
      notes:
        "本地人格和共享记忆已接入；运行中人格刷新与夜间复盘需单独核验宿主支持。",
    },
    {
      id: "models",
      title: "模型、思考档位与回退",
      adoption: "partial",
      upstreamPaths: [
        "apps/desktop/src/main/maker-ipc/botModelSelectionCoordinator.ts",
        "apps/desktop/src/main/maker-ipc/botModelRouteReconciler.ts",
      ],
      localPaths: ["server/runtime.ts", "shared/vendor/modelRoute.ts"],
      notes: "模型切换依赖公开宿主能力；回退链执行未视为已完成。",
    },
    {
      id: "routines",
      title: "定时任务与会话模式",
      adoption: "partial",
      upstreamPaths: [
        "apps/desktop/src/main/maker-ipc/schedule.ts",
        "packages/maker-scheduler",
      ],
      localPaths: ["server/schedules.ts", "server/schedule-sdk.ts"],
      notes:
        "复用 Paseo 原生调度；核对 fresh/persistent、重试、权限和状态恢复。",
    },
    {
      id: "capabilities",
      title: "技能、工具权限与能力隔离",
      adoption: "partial",
      upstreamPaths: [
        "apps/desktop/src/main/maker-ipc/botCapabilityService.ts",
        "apps/desktop/src/main/maker-ipc/botSkillService.ts",
        "packages/maker-core/src/agents/capability-route-support.ts",
      ],
      localPaths: ["server/service.ts", "server/presets/skills.ts"],
      notes: "完整能力选择与隔离仍需逐项确认，不能以设置表单存在当作支持。",
    },
    {
      id: "history",
      title: "长期伙伴会话与历史搜索",
      adoption: "partial",
      upstreamPaths: [
        "apps/desktop/src/main/maker-ipc/botCanonicalSessionRegistry.ts",
        "apps/desktop/src/main/maker-ipc/botCanonicalReplacementCoordinator.ts",
        "packages/maker-core/src/session.ts",
      ],
      localPaths: ["server/runtime.ts", "server/service.ts"],
      notes:
        "原生 canonical 会话与有界历史搜索已接入，核对分页、恢复与检索完整性。",
    },
    {
      id: "voice-im",
      title: "语音与外部聊天入口",
      adoption: "missing",
      upstreamPaths: [
        "packages/voice-input-core",
        "packages/lizi-im",
        "apps/desktop/src/main/maker-ipc/channels.ts",
        "packages/maker-core/src/voice-call.ts",
      ],
      localPaths: [],
      notes:
        "尚未迁移外部消息和语音通道；仅建议，不能擅自开启账号或发送外部消息。",
    },
    {
      id: "computer",
      title: "电脑控制、远程设备与文件",
      adoption: "missing",
      upstreamPaths: [
        "packages/browser-control-runtime",
        "packages/device-link",
        "packages/remote-file-service",
        "apps/desktop/src/main/maker-ipc/computerStatusHandler.ts",
      ],
      localPaths: [],
      notes:
        "需评估 Paseo 可复用能力、平台支持与权限成本；不默认要求替换整个宿主外壳。",
    },
  ],
});

export function cindyDraft(): Partial<WatchDraft> {
  return {
    name: "Cindy / 核心功能移植建议",
    pluginId: "cindy-companion",
    repository: "makecindy/cindy",
    baseline: "118767c987f518286ae10a506a54287c3dc2a560",
    ref: "",
    paths: [],
    relationship: "reference",
    review: JSON.parse(JSON.stringify(cindyReview)),
    notes:
      "全仓库定期扫描；以核心清单对照实际插件源码，只提出有证据的移植建议。不得自动实施未来改动或推进基线。",
  };
}

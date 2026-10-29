import { reviewSchema, type WatchDraft } from "./contracts";

/** Derived from the companion CORE_FEATURES matrix; declarations require source and live-evidence review. */
export const cindyReview = reviewSchema.parse({
  mode: "recommend-only",
  autoReview: false,
  features: [
    {
      id: "teammate-entry",
      title: "伙伴入口与活动排序",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/TeammatesSection.tsx",
      ],
      localPaths: ["CORE_FEATURES.md", "client/sidebar.tsx"],
      adoption: "partial",
      notes:
        "本地矩阵：partial: avatar chat, settings, native selection; group mixing implementing。完整验收边界见 CORE_FEATURES.md 的 teammate-entry。",
    },
    {
      id: "settings",
      title: "原版设置抽屉与自动保存",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotSettingsDrawer.tsx",
        "apps/desktop/src/renderer/features/bots/botSettingsAutosave.ts",
      ],
      localPaths: ["CORE_FEATURES.md", "client/settings.tsx", "web/App.tsx"],
      adoption: "partial",
      notes:
        "本地矩阵：partial: original drawer rendered in installed Paseo; editing/compact acceptance open。完整验收边界见 CORE_FEATURES.md 的 settings。",
    },
    {
      id: "preset-catalog",
      title: "官方伙伴预设目录",
      upstreamPaths: [
        "apps/desktop/src/main/bot-import/nativePackage.ts",
        "apps/desktop/src/renderer/features/bots/BotMarketDialog.tsx",
      ],
      localPaths: [
        "CORE_FEATURES.md",
        "shared/presets.ts",
        "server/presets/catalog.ts",
      ],
      adoption: "partial",
      notes:
        "本地矩阵：implementing: original catalog/UI and all 100 package files。完整验收边界见 CORE_FEATURES.md 的 preset-catalog。",
    },
    {
      id: "preset-install",
      title: "预设邀请、技能与资源安装",
      upstreamPaths: ["docs/product-rules/bot-market-native.md"],
      localPaths: [
        "CORE_FEATURES.md",
        "server/presets/import.ts",
        "server/presets/skills.ts",
      ],
      adoption: "partial",
      notes:
        "本地矩阵：implementing: persistent receipt, 30 skills, 10 references, 18 disabled definitions。完整验收边界见 CORE_FEATURES.md 的 preset-install。",
    },
    {
      id: "preset-opening",
      title: "邀请欢迎语与开场选项",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotInvitationWelcome.tsx",
        "apps/desktop/src/renderer/features/bots/BotStarterOptions.tsx",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes:
        "本地矩阵：open: original opening saved in receipt, not yet surfaced in native chat。完整验收边界见 CORE_FEATURES.md 的 preset-opening。",
    },
    {
      id: "custom-teammate",
      title: "自定义伙伴与原版头像",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotRosterView.tsx",
        "apps/desktop/src/renderer/features/bots/BotPortraitPicker.tsx",
      ],
      localPaths: ["CORE_FEATURES.md", "server/store.ts"],
      adoption: "partial",
      notes:
        "本地矩阵：partial: durable idempotent basic creation。完整验收边界见 CORE_FEATURES.md 的 custom-teammate。",
    },
    {
      id: "identity",
      title: "人格与版本化主页",
      upstreamPaths: [
        "apps/desktop/src/main/maker-ipc/botProfileFolder.ts",
        "apps/desktop/src/main/localDb/ipc/botProfileVersioning.ts",
      ],
      localPaths: [
        "CORE_FEATURES.md",
        "server/runtime.ts",
        "server/vendor/botProfileFolder.ts",
      ],
      adoption: "partial",
      notes:
        "本地矩阵：verified core storage/runtime context; live edit refresh depends on host API。完整验收边界见 CORE_FEATURES.md 的 identity。",
    },
    {
      id: "memory",
      title: "长期记忆、引用与检索",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotMemorySettings.tsx",
        "packages/maker-core/src/memory",
      ],
      localPaths: ["CORE_FEATURES.md", "server/memory.ts", "server/mcp.ts"],
      adoption: "partial",
      notes:
        "本地矩阵：verified read/write/context through real MCP and settings; semantic search not ported。完整验收边界见 CORE_FEATURES.md 的 memory。",
    },
    {
      id: "skills-capabilities",
      title: "自有技能、工具选择与隔离",
      upstreamPaths: [
        "apps/desktop/src/main/maker-ipc/botSkillStore.ts",
        "apps/desktop/src/main/maker-ipc/botSkillService.ts",
        "apps/desktop/src/renderer/features/bots/BotCapabilitySettings.tsx",
      ],
      localPaths: [
        "CORE_FEATURES.md",
        "server/presets/skills.ts",
        "server/runtime.ts",
      ],
      adoption: "partial",
      notes:
        "本地矩阵：partial: preset skills verified and injected; external selection/isolation and learned skills open。完整验收边界见 CORE_FEATURES.md 的 skills-capabilities。",
    },
    {
      id: "native-chat",
      title: "长期伙伴会话与工作过程",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotSessionView.tsx",
        "apps/desktop/src/renderer/features/bots/botConversationPresentation.ts",
      ],
      localPaths: ["CORE_FEATURES.md", "server/runtime.ts"],
      adoption: "partial",
      notes:
        "本地矩阵：partial: Paseo native chat and history。完整验收边界见 CORE_FEATURES.md 的 native-chat。",
    },
    {
      id: "topics-quotes",
      title: "私聊话题与引用来源",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotDmThreadHost.tsx",
        "apps/desktop/src/renderer/features/bots/BotChatQuoteViews.tsx",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes:
        "本地矩阵：open。完整验收边界见 CORE_FEATURES.md 的 topics-quotes。",
    },
    {
      id: "groups-discussion",
      title: "群聊单发言人队列",
      upstreamPaths: [
        "docs/product-rules/bot-group-chat.md",
        "apps/desktop/src/renderer/features/bots/BotGroupChatView.tsx",
      ],
      localPaths: [
        "CORE_FEATURES.md",
        "shared/groups.ts",
        "server/group-driver.ts",
      ],
      adoption: "partial",
      notes:
        "本地矩阵：implementing: durable rounds and dedicated native lanes; original creation/presentation adaptation。完整验收边界见 CORE_FEATURES.md 的 groups-discussion。",
    },
    {
      id: "groups-members",
      title: "群创建、成员与回复方式",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotGroupSettingsDrawer.tsx",
        "apps/desktop/src/renderer/features/bots/BotAddToGroupMenu.tsx",
      ],
      localPaths: ["CORE_FEATURES.md", "shared/groups.ts", "server/service.ts"],
      adoption: "partial",
      notes:
        "本地矩阵：implementing backend; UI being connected。完整验收边界见 CORE_FEATURES.md 的 groups-members。",
    },
    {
      id: "groups-work",
      title: "群分工、负责人和工作目录",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotGroupPlan.tsx",
        "apps/desktop/src/renderer/features/bots/BotGroupTaskCard.tsx",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes: "本地矩阵：open。完整验收边界见 CORE_FEATURES.md 的 groups-work。",
    },
    {
      id: "groups-rich-history",
      title: "群话题、附件、反应和发件箱",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotGroupThreadViews.tsx",
        "apps/desktop/src/renderer/features/bots/BotGroupMessageAttachments.tsx",
        "apps/desktop/src/renderer/features/bots/botGroupOutbox.ts",
      ],
      localPaths: ["CORE_FEATURES.md", "shared/groups.ts"],
      adoption: "partial",
      notes:
        "本地矩阵：partial: durable local text history; remaining rich interactions open。完整验收边界见 CORE_FEATURES.md 的 groups-rich-history。",
    },
    {
      id: "companion-collaboration",
      title: "伙伴私信、后台委派与完成回投",
      upstreamPaths: [
        "apps/desktop/src/main/maker-ipc/botDirectMessageService.ts",
        "apps/desktop/src/main/maker-ipc/botDelegationService.ts",
        "apps/desktop/src/renderer/features/bots/BotCollaborationCard.tsx",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes:
        "本地矩阵：open。完整验收边界见 CORE_FEATURES.md 的 companion-collaboration。",
    },
    {
      id: "models",
      title: "模型、思考、速度与回退链",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotModelChainEditor.tsx",
        "apps/desktop/src/main/maker-ipc/botModelRouteReconciler.ts",
      ],
      localPaths: [
        "CORE_FEATURES.md",
        "server/runtime.ts",
        "shared/vendor/modelRoute.ts",
      ],
      adoption: "partial",
      notes:
        "本地矩阵：partial: original controls and public host API PR; multi-route recovery open。完整验收边界见 CORE_FEATURES.md 的 models。",
    },
    {
      id: "routines",
      title: "定时任务、触发器与会话模式",
      upstreamPaths: [
        "docs/product-rules/bot-routines.md",
        "apps/desktop/src/renderer/features/bots/BotRoutines.tsx",
      ],
      localPaths: [
        "CORE_FEATURES.md",
        "server/schedules.ts",
        "server/schedule-sdk.ts",
      ],
      adoption: "partial",
      notes:
        "本地矩阵：partial: cron/fresh real run verified; disabled preset drafts implementing; remaining modes open。完整验收边界见 CORE_FEATURES.md 的 routines。",
    },
    {
      id: "autonomy-todos",
      title: "近况、待办、自主跟进与夜间复盘",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotAutonomySettings.tsx",
        "apps/desktop/src/renderer/features/bots/BotGlancePopover.tsx",
        "docs/product-rules/cindy-bots-runtime.md",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes:
        "本地矩阵：open。完整验收边界见 CORE_FEATURES.md 的 autonomy-todos。",
    },
    {
      id: "history-lifecycle",
      title: "历史搜索与生命周期",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotHistorySessionView.tsx",
        "apps/desktop/src/renderer/features/bots/BotLifecycleSettings.tsx",
      ],
      localPaths: ["CORE_FEATURES.md", "server/service.ts"],
      adoption: "partial",
      notes:
        "本地矩阵：partial: bounded history search and reversible profile deletion preserving native history。完整验收边界见 CORE_FEATURES.md 的 history-lifecycle。",
    },
    {
      id: "linked-projects",
      title: "项目关联与工作台",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotProjectsSettings.tsx",
        "apps/desktop/src/main/maker-ipc/botLinkedProjects.ts",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes:
        "本地矩阵：open。完整验收边界见 CORE_FEATURES.md 的 linked-projects。",
    },
    {
      id: "voice",
      title: "语音预览、朗读与对话",
      upstreamPaths: [
        "docs/product-rules/companion-voice-mode.md",
        "apps/desktop/src/renderer/features/bots/voice",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes:
        "本地矩阵：open: settings rows present but unsupported actions explicitly fail。完整验收边界见 CORE_FEATURES.md 的 voice。",
    },
    {
      id: "messaging",
      title: "外部聊天入口与消息路由",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotChannelsPage.tsx",
        "apps/desktop/src/main/im/shared/botImConnectionRuntime.ts",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes: "本地矩阵：open。完整验收边界见 CORE_FEATURES.md 的 messaging。",
    },
    {
      id: "import-existing",
      title: "导入现有伙伴与来源预览",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/BotImportForm.tsx",
        "apps/desktop/src/main/bot-import",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes:
        "本地矩阵：open。完整验收边界见 CORE_FEATURES.md 的 import-existing。",
    },
    {
      id: "cross-device",
      title: "主电脑、跨端接管与共享状态",
      upstreamPaths: [
        "docs/product-rules/cloud-companions.md",
        "apps/desktop/src/renderer/features/bots/BotHomeComputerSetting.tsx",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes:
        "本地矩阵：open; native Paseo access to the same host remains available。完整验收边界见 CORE_FEATURES.md 的 cross-device。",
    },
    {
      id: "shared-invites",
      title: "共享邀请与跨账号参与",
      upstreamPaths: [
        "apps/desktop/src/renderer/features/bots/ChatInviteDialog.tsx",
        "docs/product-rules/shared-task-mode.md",
      ],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "missing",
      notes:
        "本地矩阵：open; depends on an authorized shared service, not arbitrary URL loading。完整验收边界见 CORE_FEATURES.md 的 shared-invites。",
    },
    {
      id: "mobile",
      title: "移动端伙伴与设置流程",
      upstreamPaths: ["apps/mobile"],
      localPaths: ["CORE_FEATURES.md", "client/conversation.tsx"],
      adoption: "partial",
      notes:
        "本地矩阵：partial: native Paseo companion chat; original HTML settings limited to web/desktop。完整验收边界见 CORE_FEATURES.md 的 mobile。",
    },
    {
      id: "upstream-tracking",
      title: "移植维护与上游追踪",
      upstreamPaths: ["README.md"],
      localPaths: ["CORE_FEATURES.md"],
      adoption: "out-of-scope",
      notes:
        "Paseo 移植维护项，不是 Cindy 原有能力。README 仅作仓库入口证据；由本插件定期审查，不自动实施或推进基线。",
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
      "全仓库定期扫描；以 CORE_FEATURES.md 和核心清单对照实际插件源码，只提出有证据的移植建议。不得自动实施未来改动或推进基线。",
  };
}

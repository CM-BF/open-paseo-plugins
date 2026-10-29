import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { overviewRpc } from "../shared/contracts";
import { ActivityTab } from "./activity-tab";
import { Tabs } from "./kit";
import { MemoryTab } from "./memory-tab";
import { OverviewTab } from "./overview";
import { SessionsTab } from "./sessions-tab";
import { SkillsTab } from "./skills-tab";

type Tab = "overview" | "memory" | "skills" | "sessions" | "activity";
const TABS: readonly Tab[] = ["overview", "memory", "skills", "sessions", "activity"];

export function LearningScreen({ theme, layout, params, navigation, onOpenSettings }: PluginScreenProps & { onOpenSettings(): void }) {
  const initial = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : "overview";
  const [tab, setTab] = useState<Tab>(initial);
  const overview = useRpc(overviewRpc);
  const pending = useQuery({ queryKey: ["overview"], queryFn: () => overview({}), refetchInterval: 15_000 }).data?.pending ?? 0;
  const pad = layout.compact ? 14 : 24;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 16, paddingBottom: 48 }}>
      <View style={{ maxWidth: 900, width: "100%", alignSelf: "center", gap: 16 }}>
        <Tabs<Tab>
          theme={theme}
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "overview", label: "Overview", icon: "LayoutDashboard" },
            { id: "memory", label: "Memory", icon: "NotebookPen", badge: pending },
            { id: "skills", label: "Skills", icon: "BookOpen" },
            { id: "sessions", label: "Sessions", icon: "Search" },
            { id: "activity", label: "Activity", icon: "Activity" },
          ]}
        />
        {tab === "overview" ? <OverviewTab theme={theme} onOpen={setTab} onOpenSettings={onOpenSettings} /> : null}
        {tab === "memory" ? <MemoryTab theme={theme} /> : null}
        {tab === "skills" ? <SkillsTab theme={theme} compact={layout.compact} /> : null}
        {tab === "sessions" ? <SessionsTab theme={theme} navigation={navigation} /> : null}
        {tab === "activity" ? <ActivityTab theme={theme} /> : null}
      </View>
    </ScrollView>
  );
}

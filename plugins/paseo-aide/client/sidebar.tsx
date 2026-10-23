import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { SCREEN_HOME } from "../shared/ids";
import { useBadge } from "./queries";

/** The sidebar row, with the number of open alerts beside it. */
export function AideItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const badge = useBadge();
  const count = badge.data?.openAlerts ?? 0;
  return (
    <SidebarRow
      icon="Sparkles"
      active={currentScreen?.screenId === SCREEN_HOME}
      onPress={() => openScreen({ screenId: SCREEN_HOME })}
      trailing={
        count > 0 ? (
          <View style={{ minWidth: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: theme.colors.accent, alignItems: "center" }}>
            <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "700" }}>{count}</Text>
          </View>
        ) : undefined
      }
    />
  );
}

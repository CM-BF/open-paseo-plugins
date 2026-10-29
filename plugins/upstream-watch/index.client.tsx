import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { overviewRpc, pendingCount } from "./shared/contracts";
import { overviewKey, UpstreamScreen } from "./client/screen";

function UpstreamItem({
  theme,
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const getOverview = useRpc(overviewRpc);
  const overview = useQuery({
    queryKey: overviewKey,
    queryFn: () => getOverview({}),
    refetchInterval: 30_000,
  });
  const count = pendingCount(overview.data?.watches || []);
  const errors =
    overview.data?.watches.filter((watch) => watch.enabled && watch.error)
      .length || 0;
  return (
    <SidebarRow
      icon="GitCompareArrows"
      label="上游更新"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
      trailing={
        count || errors || overview.error ? (
          <Text
            style={{
              color:
                errors || overview.error
                  ? theme.colors.statusWarning
                  : theme.colors.accent,
              fontSize: 12,
              fontWeight: "600",
            }}
          >
            {count || "!"}
          </Text>
        ) : undefined
      }
    />
  );
}
export default function contribute(client: PluginClientContext) {
  const remove = [
    client.addScreen({
      id: "main",
      title: "上游更新",
      Component: UpstreamScreen,
    }),
    client.addSidebarHeaderItem({
      id: "main",
      title: "上游更新",
      Component: UpstreamItem,
    }),
    client.addCommandCenterItem({
      id: "open",
      title: "上游更新：检查插件的参考项目与 fork",
      icon: "GitCompareArrows",
      keywords: ["upstream", "update", "fork", "reference", "上游", "更新"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "main" });
      },
    }),
  ];
  return () => remove.forEach((dispose) => dispose());
}

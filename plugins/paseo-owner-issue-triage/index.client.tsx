import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { TriageScreen } from "./client/screen";

function TriageSidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="ListFilter" label="本人 issues" active={currentScreen?.screenId === "main"} onPress={() => openScreen({ screenId: "main" })} />;
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: "main", title: "Owner triage · 本人 issues", Component: TriageScreen }),
    client.addSidebarHeaderItem({ id: "owner-triage", title: "Owner triage", Component: TriageSidebar }),
    client.addCommandCenterItem({
      id: "open-owner-triage", title: "打开本人 issues", icon: "ListFilter", context: "global",
      keywords: ["owner", "triage", "issue", "github", "本人", "问题"],
      onSelect({ openScreen }) { openScreen({ screenId: "main" }); },
    }),
  ];
  return async () => { for (const remove of removers.reverse()) await remove(); };
}

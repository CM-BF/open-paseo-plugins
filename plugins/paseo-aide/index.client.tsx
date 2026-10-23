import type { PluginClientContext } from "@getpaseo/plugin/client";
import { setClient } from "./client/client-ref";
import { HomeScreen } from "./client/home";
import { SettingsScreen } from "./client/settings-screen";
import { AideItem } from "./client/sidebar";
import { UpdateCard } from "./client/update-row";
import { SCREEN_HOME, SETTINGS_SCREEN, UPDATE_KIND, UPDATE_VERSION } from "./shared/ids";
import { briefNowRpc, checkNowRpc } from "./shared/rpc";
import { decodeUpdate, UpdateRowSchema } from "./shared/update";

export default function contribute(client: PluginClientContext) {
  setClient(client);
  const removers = [
    client.addScreen({ id: SCREEN_HOME, title: "Aide", Component: HomeScreen }),
    client.addSidebarHeaderItem({ id: "aide", title: "Aide", Component: AideItem }),
    client.addSettingsScreen({ id: SETTINGS_SCREEN, title: "Aide", icon: "Sparkles", Component: SettingsScreen }),
    client.addTimelineTransformer({
      id: "aide-update",
      query: { itemType: "user_message" },
      transform({ item }) {
        const row = decodeUpdate(item.text);
        return row ? { items: [{ type: "plugin", kind: UPDATE_KIND, version: UPDATE_VERSION, data: row }] } : undefined;
      },
    }),
    client.addTimelineRenderer({ kind: UPDATE_KIND, version: UPDATE_VERSION, schema: UpdateRowSchema, Component: UpdateCard }),
    client.addCommandCenterItem({
      id: "open-aide",
      title: "Open Aide",
      icon: "Sparkles",
      keywords: ["aide", "assistant", "personal agent", "brief", "check-in", "needs you"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_HOME });
      },
    }),
    client.addCommandCenterItem({
      id: "aide-check-now",
      title: "Aide: check in now",
      icon: "Radar",
      keywords: ["aide", "check", "watch", "proactive"],
      context: "global",
      async onSelect({ rpc, openScreen }) {
        await rpc(checkNowRpc, {});
        openScreen({ screenId: SCREEN_HOME });
      },
    }),
    client.addCommandCenterItem({
      id: "aide-brief-now",
      title: "Aide: brief me now",
      icon: "Sunrise",
      keywords: ["aide", "brief", "summary", "today"],
      context: "global",
      async onSelect({ rpc }) {
        await rpc(briefNowRpc, {});
      },
    }),
  ];
  return async () => {
    setClient(null);
    for (const remove of removers.reverse()) await remove();
  };
}

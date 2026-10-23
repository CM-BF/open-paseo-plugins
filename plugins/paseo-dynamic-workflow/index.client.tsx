import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RunCard } from "./client/card";
import { setClient } from "./client/hooks";
import { NoticeRow } from "./client/notice";
import { RunsPanel } from "./client/panel";
import { SettingsScreen } from "./client/settings-screen";
import { CARD_KIND, CARD_VERSION, PANEL_ID } from "./shared/ids";
import { NOTICE_KIND, NOTICE_VERSION, NoticeDataSchema, parseNotice } from "./shared/notification";
import { CardDataSchema } from "./shared/run-types";

export default function contribute(client: PluginClientContext) {
  setClient(client);
  const removers = [
    client.addTimelineRenderer({ kind: CARD_KIND, version: CARD_VERSION, schema: CardDataSchema, Component: RunCard }),
    client.addTimelineTransformer({
      id: "notice",
      query: { itemType: "user_message" },
      transform({ item }) {
        const data = parseNotice(item.text);
        return data ? { items: [{ type: "plugin", kind: NOTICE_KIND, version: NOTICE_VERSION, data }] } : undefined;
      },
    }),
    client.addTimelineRenderer({ kind: NOTICE_KIND, version: NOTICE_VERSION, schema: NoticeDataSchema, Component: NoticeRow }),
    client.addWorkspacePanel({ id: PANEL_ID, title: "Dynamic workflows", icon: "Workflow", context: "agent", Component: RunsPanel }),
    client.addCommandCenterItem({
      id: "show-dynamic-workflows",
      title: "Dynamic workflow tools and runs",
      icon: "Workflow",
      keywords: ["workflow", "workflows", "dynamic", "tools", "enable", "settings", "orchestration", "agents", "fan out"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel(PANEL_ID);
      },
    }),
    client.addSlashCommand({
      name: "dynamic-workflows",
      description: "Enable workflow tools for this agent and view its runs",
      argumentHint: "",
      context: "agent",
      onSubmit({ openPanel }) {
        openPanel(PANEL_ID);
      },
    }),
    client.addSettingsScreen({ id: "preferences", title: "Dynamic workflows", icon: "Workflow", Component: SettingsScreen }),
  ];
  return async () => {
    setClient(null);
    for (const remove of removers.reverse()) await remove();
  };
}

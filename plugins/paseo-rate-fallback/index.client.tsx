import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsScreen } from "./client/settings-screen";
import { TransferRow } from "./client/transfer-row";
import { transferSchema } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addSettingsScreen({
      id: "settings",
      title: "自动模型切换",
      icon: "ArrowLeftRight",
      Component: SettingsScreen,
    }),
    client.addTimelineRenderer({
      kind: "provider-transfer",
      version: 1,
      schema: transferSchema,
      Component: TransferRow,
    }),
  ];
  return async () => {
    for (const remove of removers.reverse()) await remove();
  };
}

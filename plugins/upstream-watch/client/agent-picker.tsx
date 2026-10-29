import { useRpc } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { environmentRpc, modelsRpc } from "../shared/contracts";
import { Body, type Themed } from "./kit";

export interface AgentSelection {
  workspaceId: string;
  provider: string;
}
export function AgentPicker({
  theme,
  value,
  onChange,
}: Themed & { value: AgentSelection; onChange(value: AgentSelection): void }) {
  const getEnvironment = useRpc(environmentRpc);
  const getModels = useRpc(modelsRpc);
  const [family, setFamily] = useState(value.provider.split("/")[0] || "");
  const environment = useQuery({
    queryKey: ["upstream-watch", "environment"],
    queryFn: () => getEnvironment({}),
    staleTime: 30_000,
  });
  const selectedWorkspace = environment.data?.workspaces.find(
    (workspace) => workspace.id === value.workspaceId,
  );
  const models = useQuery({
    queryKey: [
      "upstream-watch",
      "models",
      family,
      selectedWorkspace?.directory,
    ],
    queryFn: () =>
      getModels({ provider: family, cwd: selectedWorkspace?.directory }),
    enabled: Boolean(family),
    staleTime: 60_000,
  });
  return (
    <View style={{ gap: 8 }}>
      <SettingsSelect
        label="更新任务工作区"
        value={value.workspaceId}
        options={[
          { value: "", label: "选择包含插件源码的工作区" },
          ...(environment.data?.workspaces || []).map((workspace) => ({
            value: workspace.id,
            label: `${workspace.name} — ${workspace.directory}`,
          })),
        ]}
        onValueChange={(workspaceId) => onChange({ ...value, workspaceId })}
      />
      <SettingsSelect
        label="Agent provider"
        value={family}
        options={[
          { value: "", label: "选择 provider" },
          ...(environment.data?.providers || []).map((provider) => ({
            value: provider.id,
            label: provider.label,
          })),
        ]}
        onValueChange={(next) => {
          setFamily(next);
          onChange({ ...value, provider: "" });
        }}
      />
      {family ? (
        <SettingsSelect
          label="更新任务模型"
          value={value.provider}
          options={[
            {
              value: "",
              label: models.isFetching ? "正在读取模型…" : "选择模型",
            },
            ...(models.data || []).map((model) => ({
              value: model.id,
              label: model.label,
            })),
          ]}
          onValueChange={(provider) => onChange({ ...value, provider })}
        />
      ) : null}
      {environment.error || models.error ? (
        <Body theme={theme}>{String(environment.error || models.error)}</Body>
      ) : null}
      <Body theme={theme} muted>
        只在你点“开更新 agent”后创建会话，使用 provider 原有的权限设置。
      </Body>
    </View>
  );
}

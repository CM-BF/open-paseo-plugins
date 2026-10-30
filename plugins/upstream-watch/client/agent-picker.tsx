import { useRpc } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { View } from "react-native";
import { environmentRpc, modelsRpc } from "../shared/contracts";
import { Body, type Themed } from "./kit";
import { WorkspacePicker } from "./workspace-picker";

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
  const queryClient = useQueryClient();
  const latestSelection = useRef({ value, onChange });
  latestSelection.current = { value, onChange };
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
    <View style={{ minWidth: 0, gap: 8 }}>
      <WorkspacePicker
        theme={theme}
        value={value.workspaceId}
        workspaces={environment.data?.workspaces || []}
        projects={environment.data?.projects || []}
        loading={environment.isLoading}
        refreshing={environment.isFetching}
        onRefresh={() => { void environment.refetch(); }}
        onChange={(workspaceId) => {
          const current = latestSelection.current;
          current.onChange({ ...current.value, workspaceId });
        }}
        onCreated={async (workspace, isCurrent) => {
          if (!isCurrent()) return false;
          await queryClient.cancelQueries({ queryKey: ["upstream-watch", "environment"] });
          if (!isCurrent()) return false;
          queryClient.setQueryData<typeof environment.data>(["upstream-watch", "environment"], (current) =>
            current ? { ...current, workspaces: [...current.workspaces.filter((item) => item.id !== workspace.id), workspace] } : current,
          );
          const current = latestSelection.current;
          current.onChange({ ...current.value, workspaceId: workspace.id });
          void queryClient.invalidateQueries({ queryKey: ["upstream-watch", "environment"] });
          return true;
        }}
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

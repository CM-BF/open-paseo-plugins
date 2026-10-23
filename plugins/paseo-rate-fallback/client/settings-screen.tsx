import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { configureRpc, statusRpc } from "../shared/contracts";

const STATUS_KEY = ["paseo-rate-fallback", "status"] as const;

const PHASE_LABELS: Readonly<Record<string, string>> = {
  switching: "正在切换到备用模型",
  forking: "正在创建备用会话",
  fallback: "备用模型运行中",
  blocked: "等待恢复",
  restoring: "正在恢复主模型",
  returning: "正在交回原会话并继续",
  returned: "已返回原会话",
  paused: "会话交接已暂停",
};

function errorMessage(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  return error instanceof Error ? error.message : String(error);
}

function resetLabel(resetAt: number | null): string {
  if (resetAt === null) return "未收到重置时间，每 5 分钟尝试恢复";
  return `额度重置：${new Date(resetAt).toLocaleString()}`;
}

export function SettingsScreen({ theme, layout, navigation }: PluginSurfaceProps) {
  const readStatus = useRpc(statusRpc);
  const configure = useRpc(configureRpc);
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => readStatus({}),
    refetchInterval: 5_000,
    retry: 1,
  });
  const save = useMutation({
    mutationFn: configure,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
  const data = status.data;
  const enabled = save.isPending ? save.variables.enabled : (data?.enabled ?? false);
  const openAgent = navigation?.openAgent;

  return (
    <View style={{ gap: layout.compact ? 16 : 24 }}>
      <SettingsSection title="自动模型切换">
        <SettingsCard>
          <SettingsSwitch
            label="主模型限流后自动切换"
            hint="适用于 Claude 和 Codex。Claude 限流时创建 GPT 备用会话；Codex 限流时直接调整模型。"
            value={enabled}
            disabled={!data || save.isPending}
            onValueChange={(value) => save.mutate({ enabled: value })}
            error={errorMessage(save.error)}
          />
          <SettingsRow
            label="备用模型"
            hint={`${data?.fallbackModel ?? "gpt-6.1-sol"} · ${data?.fallbackThinking ?? "ultra"}`}
          />
          <SettingsRow
            label="Claude 会话交接"
            hint="在同一工作区创建备用会话，共用项目文件，并携带对话快照和工作进展；提供商内部会话状态不会随快照迁移。"
          />
          <SettingsRow
            label="自动返回"
            hint="Claude 额度重置且双方空闲后，将备用会话进展交回原会话。Codex 会话恢复原模型和思考强度。已完成的任务只交付结果。"
          />
          <SettingsRow
            label="停用后的处理"
            hint="停止新的备用切换。Codex 在空闲时恢复；已有 Claude 交接仍需等待额度恢复且双方空闲后交回。"
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="切换状态">
        <SettingsCard>
          <SettingsAction
            label={status.isPending ? "正在读取状态…" : "刷新状态"}
            hint="打开本页时每 5 秒更新。"
            actionLabel={status.isFetching ? "刷新中…" : "刷新"}
            disabled={status.isFetching}
            onPress={() => void status.refetch()}
            error={errorMessage(status.error) ?? data?.error}
          />
          {data?.agents.length === 0 ? (
            <SettingsRow label="暂无切换中的会话" hint="检测到主模型限流后，会在这里显示会话和恢复时间。" />
          ) : null}
        </SettingsCard>
        {data?.agents.map((agent) => (
          <SettingsCard key={agent.agentId}>
            <SettingsRow label={PHASE_LABELS[agent.phase] ?? agent.phase} error={agent.lastError}>
              <View style={{ gap: 4, paddingVertical: 6 }}>
                <Text selectable style={{ color: theme.colors.foreground, fontSize: 13 }}>
                  原模型：{agent.mainProvider ?? "codex"} / {agent.mainModel} · {agent.mainThinking ?? "默认思考强度"}
                </Text>
                <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  备用模型：codex / {data.fallbackModel} · {data.fallbackThinking}
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  {resetLabel(agent.resetAt)}
                </Text>
                <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  原会话：{agent.agentId}
                </Text>
                {agent.transferKind === "fork" || agent.fallbackAgentId ? (
                  <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                    备用会话：{agent.fallbackAgentId ?? "正在创建"}
                  </Text>
                ) : null}
              </View>
            </SettingsRow>
            {openAgent ? (
              <SettingsAction label="原会话" actionLabel="打开" onPress={() => openAgent({ agentId: agent.agentId })} />
            ) : null}
            {openAgent && agent.fallbackAgentId ? (
              <SettingsAction
                label="备用会话"
                actionLabel="打开"
                onPress={() => {
                  if (agent.fallbackAgentId) openAgent({ agentId: agent.fallbackAgentId });
                }}
              />
            ) : null}
          </SettingsCard>
        ))}
      </SettingsSection>
    </View>
  );
}

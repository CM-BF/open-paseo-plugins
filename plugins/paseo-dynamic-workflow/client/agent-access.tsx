import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { getAgentAccessRpc, setAgentAccessRpc } from "../shared/contracts";
import { PLUGIN_ID } from "../shared/ids";
import { errorMessage } from "./format";
import type { Styles } from "./styles";

/** Fetch only while this agent's panel is open; ordinary conversations need no access subscription. */
export function AgentAccess({ agentId, styles }: { agentId: string; styles: Styles }) {
  const getAccess = useRpc(getAgentAccessRpc);
  const setAccess = useRpc(setAgentAccessRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const queryKey = [PLUGIN_ID, "agent-access", agentId];
  const access = useQuery({ queryKey, queryFn: () => getAccess({ agentId }) });
  const update = useMutation({
    mutationFn: (enabled: boolean) => setAccess({ agentId, enabled }),
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSuccess: (value) => queryClient.setQueryData(queryKey, value),
  });
  const value = access.data;
  const mcpFamily = value?.providerFamily === "claude" || value?.providerFamily === "codex";
  const mcp = mcpFamily && value?.hasMcpBinding;
  const referenceCommand = value ? `'${value.cliPath.replace(/'/g, "'\\''")}' reference` : "";

  return (
    <View style={{ gap: 8 }}>
      <SettingsCard>
        <SettingsSwitch
          label="Enable workflow tools for this agent"
          hint={value?.isWorkflowChild
            ? "Workflow child agents cannot launch another workflow."
            : "Off by default. Enable only for conversations that need workflows."}
          value={value?.enabled ?? false}
          disabled={!value || value.isWorkflowChild || access.isError || update.isPending}
          onValueChange={(enabled) => update.mutate(enabled)}
          error={update.isError ? `Could not save: ${errorMessage(update.error)}` : null}
        />
      </SettingsCard>
      {access.isPending ? <Text style={styles.mutedText}>Loading this agent's tool access…</Text> : null}
      {access.isError ? (
        <Pressable onPress={() => void access.refetch()} accessibilityRole="button">
          <Text style={styles.danger}>Could not load tool access: {errorMessage(access.error)} · Tap to retry</Text>
        </Pressable>
      ) : null}
      {update.isPending ? <Text style={styles.mutedText}>Saving tool access…</Text> : null}
      {value && !value.isWorkflowChild ? (
        <Text style={styles.mutedText}>
          {mcp
            ? "Reload this agent after changing the switch to refresh its tool list. Use Reload from the agent menu."
            : value.enabled
              ? mcpFamily
                ? "This agent predates workflow tool setup; use the command below, or create a new agent for MCP tools."
                : "Include this reference command in your next prompt so the agent can learn how to run workflows."
              : "Enable to get the workflow reference command for this agent."}
        </Text>
      ) : null}
      {value?.enabled && !value.isWorkflowChild && !mcp ? (
        <View style={styles.panelCard}>
          <Text style={styles.mono} selectable>{referenceCommand}</Text>
          <Pressable
            onPress={() => void copyText(referenceCommand).then(
              () => toast.show("Reference command copied"),
              (error) => toast.error(`Could not copy: ${errorMessage(error)}`),
            )}
            accessibilityRole="button"
            accessibilityLabel="Copy workflow reference command"
          >
            <Text style={styles.link}>Copy reference command</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

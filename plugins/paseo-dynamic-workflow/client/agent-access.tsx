import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { getAgentAccessRpc, reloadAgentRpc, setAgentAccessRpc } from "../shared/contracts";
import { PLUGIN_ID } from "../shared/ids";
import { errorMessage } from "./format";
import type { Styles } from "./styles";

/** Fetch only while this agent's panel is open; ordinary conversations need no access subscription. */
export function AgentAccess({ agentId, styles }: { agentId: string; styles: Styles }) {
  const getAccess = useRpc(getAgentAccessRpc);
  const setAccess = useRpc(setAgentAccessRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  // Versioned: a reload keeps query state, and older cached results lack the Ultracode flag.
  const queryKey = [PLUGIN_ID, "agent-access", 2, agentId];
  const access = useQuery({ queryKey, queryFn: () => getAccess({ agentId }) });
  const reloadAgent = useRpc(reloadAgentRpc);
  const reload = useMutation({
    mutationFn: () => reloadAgent({ agentId }),
    onSuccess: (result) => (result.reloaded ? toast.show(result.message) : toast.error(result.message)),
    onError: (error) => toast.error(`Could not reload: ${errorMessage(error)}`),
  });
  const update = useMutation({
    mutationFn: (change: { enabled?: boolean; ultracode?: boolean }) => setAccess({ agentId, ...change }),
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
          onValueChange={(enabled) => update.mutate({ enabled })}
          error={update.isError && update.variables?.enabled !== undefined ? `Could not save: ${errorMessage(update.error)}` : null}
        />
        <SettingsSwitch
          label="Ultracode for this agent"
          hint={value?.ultracode
            ? "On: workflows are a standing opt-in for this agent, and it orchestrates every substantive task exhaustively (parallel coverage, adversarial verification, completeness checks). Uses many more agents and tokens. The agent gets a short message about the change."
            : value?.enabled
              ? "Off: the agent runs workflows only when asked, within the size guideline. Turn on for Claude Code style exhaustive multi-agent work."
              : "Off. Turning it on also enables workflow tools for this agent."}
          value={value?.ultracode ?? false}
          disabled={!value || value.isWorkflowChild || access.isError || update.isPending}
          onValueChange={(ultracode) => update.mutate({ ultracode })}
          error={update.isError && update.variables?.ultracode !== undefined ? `Could not save: ${errorMessage(update.error)}` : null}
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
            ? "An Ultracode change reaches the agent at once as a short message. Reload the agent from its menu when convenient so its tool list and instructions match too."
            : value.enabled
              ? mcpFamily
                ? "This agent predates workflow tool setup; use the command below, or create a new agent for MCP tools."
                : "Include this reference command in your next prompt so the agent can learn how to run workflows. After changing Ultracode, include it again: its first line states the mode."
              : "Enable to get the workflow reference command for this agent."}
        </Text>
      ) : null}
      {mcp && !value?.isWorkflowChild ? (
        <Pressable onPress={() => reload.mutate()} disabled={reload.isPending} accessibilityRole="button" accessibilityLabel="Reload this agent now">
          <Text style={styles.link}>{reload.isPending ? "Reloading…" : "Reload agent now"}</Text>
        </Pressable>
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

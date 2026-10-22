import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { serviceStatusRpc } from "../shared/contracts";
import { PLUGIN_ID } from "../shared/ids";
import { type Preferences, preferences } from "../shared/settings";
import { errorMessage } from "./format";

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const status = useRpc(serviceStatusRpc);
  const service = useQuery({ queryKey: [PLUGIN_ID, "service"], queryFn: () => status({}), refetchInterval: 10_000 });
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground, fontSize: 13 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme],
  );
  if (settings.status === "loading") return <Text style={styles.muted}>Loading settings…</Text>;
  if (settings.status === "error") return <Text style={styles.danger}>Could not load settings: {settings.error}</Text>;
  if (settings.status === "invalid") return <Text style={styles.danger}>Stored settings are invalid: {settings.error}</Text>;
  const values = settings.values;
  const save = (patch: Partial<Preferences>) => void settings.save({ ...values, ...patch }, settings.revision);
  const integer = (text: string, min: number, max: number): number | null => {
    const value = Number(text.trim());
    return Number.isInteger(value) && value >= min && value <= max ? value : null;
  };

  return (
    <View style={{ gap: 20 }}>
      <SettingsSection title="New agents">
        <SettingsCard>
          <SettingsSwitch
            label="Add workflow tools to new agents"
            hint="Claude, Codex and OpenCode get the workflow MCP tools; Pi and OMP get instructions for the paseo-workflow command. Existing agents are not changed."
            value={values.injectIntoNewAgents}
            onValueChange={(injectIntoNewAgents) => save({ injectIntoNewAgents })}
          />
          <SettingsSwitch
            label="Preapprove the workflow tools"
            hint="Agents call workflow, workflow_status, workflow_stop and workflow_reference without a permission prompt (never on OpenCode)."
            value={values.preapproveTools}
            onValueChange={(preapproveTools) => save({ preapproveTools })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Runs">
        <SettingsCard>
          <SettingsInput
            label="Concurrent agents per run"
            hint="0 means min(8, CPUs - 2). At most 16."
            initialValue={String(values.maxConcurrentAgents)}
            onChangeText={(text) => {
              const value = integer(text, 0, 16);
              if (value !== null && value !== values.maxConcurrentAgents) save({ maxConcurrentAgents: value });
            }}
          />
          <SettingsInput
            label="Agents per run"
            hint="A runaway-loop backstop. At most 1000."
            initialValue={String(values.maxAgentsPerRun)}
            onChangeText={(text) => {
              const value = integer(text, 1, 1000);
              if (value !== null && value !== values.maxAgentsPerRun) save({ maxAgentsPerRun: value });
            }}
          />
          <SettingsInput
            label="Agent time limit (minutes)"
            hint="Stop a child agent that runs longer than this. 0 means no limit."
            initialValue={String(values.agentTimeoutMinutes)}
            onChangeText={(text) => {
              const value = integer(text, 0, 1440);
              if (value !== null && value !== values.agentTimeoutMinutes) save({ agentTimeoutMinutes: value });
            }}
          />
          <SettingsSwitch
            label="Archive finished child agents"
            hint="Keeps the Subagents track short. Their transcripts stay readable in the workflow panel."
            value={values.archiveFinishedAgents}
            onValueChange={(archiveFinishedAgents) => save({ archiveFinishedAgents })}
          />
        </SettingsCard>
        {settings.saveError ? <Text style={styles.danger}>{settings.saveError}</Text> : null}
      </SettingsSection>
      <SettingsSection title="Service">
        <SettingsCard>
          {service.isError ? (
            <SettingsRow label="Status" error={errorMessage(service.error)} />
          ) : service.data ? (
            <>
              <SettingsRow label="Version" hint={service.data.version} />
              <SettingsRow
                label="Bridge"
                hint={service.data.bridgeListening ? "listening" : `not listening${service.data.bridgeError ? `: ${service.data.bridgeError}` : ""}`}
              />
              <SettingsRow label="Active runs" hint={String(service.data.activeRuns)} />
              <SettingsRow label="State directory" hint={service.data.stateDir} />
              <SettingsRow label="CLI" hint={service.data.cliPath} />
            </>
          ) : (
            <SettingsRow label="Status" hint="Loading…" />
          )}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

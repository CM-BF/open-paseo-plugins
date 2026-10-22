import { type PluginSurfaceProps, type SettingsState, useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { serviceStatusRpc } from "../shared/contracts";
import { PLUGIN_ID } from "../shared/ids";
import { preferences, PreferencesSchema } from "../shared/settings";
import { errorMessage } from "./format";
import { parseInteger } from "./settings-input";

type ReadySettings = Extract<SettingsState<typeof PreferencesSchema>, { status: "ready" }>;

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const status = useRpc(serviceStatusRpc);
  const service = useQuery({ queryKey: [PLUGIN_ID, "service"], queryFn: () => status({}), refetchInterval: 10_000 });
  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme],
  );
  if (settings.status === "loading") return <Text style={styles.muted}>Loading settings…</Text>;
  if (settings.status === "error") return <Text style={styles.danger}>Could not load settings: {settings.error}</Text>;
  if (settings.status === "invalid") return <Text style={styles.danger}>Stored settings are invalid: {settings.error}</Text>;

  return (
    <View style={{ gap: 20 }}>
      <SettingsEditor key={settings.revision} settings={settings} />
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

/** One revision, one draft, one explicit write; typing never persists a numeric prefix. */
function SettingsEditor({ settings }: { settings: ReadySettings }) {
  const [values, setValues] = useState(settings.values);
  const [numbers, setNumbers] = useState(() => ({
    maxConcurrentAgents: String(settings.values.maxConcurrentAgents),
    maxAgentsPerRun: String(settings.values.maxAgentsPerRun),
    agentTimeoutMinutes: String(settings.values.agentTimeoutMinutes),
  }));
  const concurrent = parseInteger(numbers.maxConcurrentAgents, 0, 16);
  const maxAgents = parseInteger(numbers.maxAgentsPerRun, 1, 1000);
  const timeout = parseInteger(numbers.agentTimeoutMinutes, 0, 1440);
  const valid = concurrent !== null && maxAgents !== null && timeout !== null;
  const draft = valid ? { ...values, maxConcurrentAgents: concurrent, maxAgentsPerRun: maxAgents, agentTimeoutMinutes: timeout } : null;
  const changed = draft === null || JSON.stringify(draft) !== JSON.stringify(settings.values);
  const save = async () => {
    if (draft) await settings.save(draft, settings.revision);
  };
  return (
    <View style={{ gap: 20 }}>
      <SettingsSection title="New agents">
        <SettingsCard>
          <SettingsSwitch
            label="Add workflow tools to new agents"
            hint="Claude, Codex and OpenCode get the workflow MCP tools; Pi and OMP get instructions for the paseo-workflow command. Existing agents are not changed."
            value={values.injectIntoNewAgents}
            disabled={settings.saving}
            onValueChange={(injectIntoNewAgents) => setValues((current) => ({ ...current, injectIntoNewAgents }))}
          />
          <SettingsSwitch
            label="Preapprove the workflow tools"
            hint="Agents call workflow, workflow_status, workflow_stop and workflow_reference without a permission prompt (never on OpenCode)."
            value={values.preapproveTools}
            disabled={settings.saving}
            onValueChange={(preapproveTools) => setValues((current) => ({ ...current, preapproveTools }))}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Runs">
        <SettingsCard>
          <SettingsInput
            label="Concurrent agents per run"
            hint="0 means min(8, CPUs - 2). At most 16."
            initialValue={numbers.maxConcurrentAgents}
            disabled={settings.saving}
            error={concurrent === null ? "Enter a whole number from 0 to 16." : null}
            onChangeText={(maxConcurrentAgents) => setNumbers((current) => ({ ...current, maxConcurrentAgents }))}
          />
          <SettingsInput
            label="Agents per run"
            hint="A runaway-loop backstop. At most 1000."
            initialValue={numbers.maxAgentsPerRun}
            disabled={settings.saving}
            error={maxAgents === null ? "Enter a whole number from 1 to 1000." : null}
            onChangeText={(maxAgentsPerRun) => setNumbers((current) => ({ ...current, maxAgentsPerRun }))}
          />
          <SettingsInput
            label="Agent time limit (minutes)"
            hint="Stop a child agent that runs longer than this. 0 means no limit."
            initialValue={numbers.agentTimeoutMinutes}
            disabled={settings.saving}
            error={timeout === null ? "Enter a whole number from 0 to 1440." : null}
            onChangeText={(agentTimeoutMinutes) => setNumbers((current) => ({ ...current, agentTimeoutMinutes }))}
          />
          <SettingsSwitch
            label="Archive finished child agents"
            hint="Keeps the Subagents track short. Their transcripts stay readable in the workflow panel."
            value={values.archiveFinishedAgents}
            disabled={settings.saving}
            onValueChange={(archiveFinishedAgents) => setValues((current) => ({ ...current, archiveFinishedAgents }))}
          />
          <SettingsAction
            label="Apply changes"
            actionLabel={settings.saving ? "Saving…" : "Save settings"}
            hint="Changes take effect after saving."
            disabled={!valid || !changed || settings.saving}
            onPress={() => void save()}
            error={settings.saveError}
          />
          {settings.saveError ? (
            <SettingsAction
              label="Reload stored settings"
              hint="If another client changed these settings, reload before editing again. This discards this draft."
              actionLabel="Reload"
              onPress={() => void settings.reload()}
              disabled={settings.saving}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

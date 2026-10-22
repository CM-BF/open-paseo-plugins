import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginAgentPanelProps, useAgent, useRpc } from "@getpaseo/plugin/client";
import { copyText, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { getRunRpc, listRunsRpc, skipCallRpc, stopRunRpc } from "../shared/contracts";
import { PLUGIN_ID } from "../shared/ids";
import type { AgentCall, RunDetail, RunSummary } from "../shared/run-types";
import {
  CALL_LOOK,
  elapsed,
  errorMessage,
  formatClock,
  formatTokens,
  isLiveCall,
  isLiveRun,
  plural,
  RUN_LOOK,
  toneColor,
} from "./format";
import { onRunRequested, takeRequestedRun, useNow } from "./hooks";
import { createStyles, type Styles } from "./styles";

const CALLS_PER_PHASE = 120;
const UNGROUPED = "Agents";

type Navigation = PluginAgentPanelProps["navigation"];

export function RunsPanel({ theme, layout, agentId, navigation }: PluginAgentPanelProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const agent = useAgent(agentId, (snapshot) => ({ title: snapshot.title }));
  const listRuns = useRpc(listRunsRpc);
  const [selected, setSelected] = useState<string | null>(() => takeRequestedRun(agentId) ?? null);
  useEffect(
    () =>
      onRunRequested((requestedAgent, runId) => {
        if (requestedAgent === agentId) {
          takeRequestedRun(agentId);
          setSelected(runId);
        }
      }),
    [agentId],
  );

  const list = useQuery({
    queryKey: [PLUGIN_ID, "list", agentId],
    queryFn: () => listRuns({ agentId, limit: 50 }),
    refetchInterval: (query) => (query.state.data?.runs.some((run) => isLiveRun(run.status)) ? 2000 : 10_000),
  });
  const runs = list.data?.runs ?? [];
  const runId = selected ?? runs.find((run) => isLiveRun(run.status))?.runId ?? runs[0]?.runId ?? null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      <View style={{ gap: 2 }}>
        <Text style={styles.heading}>Dynamic workflows</Text>
        <Text style={styles.mutedText} numberOfLines={1}>
          Runs launched by {agent?.title ?? "this agent"}
        </Text>
      </View>
      {list.isPending ? <Text style={styles.mutedText}>Loading runs…</Text> : null}
      {list.isError ? (
        <Pressable onPress={() => void list.refetch()} accessibilityRole="button">
          <Text style={styles.danger}>Could not load runs: {errorMessage(list.error)} · Tap to retry</Text>
        </Pressable>
      ) : null}
      {list.isSuccess && runs.length === 0 ? (
        <View style={styles.panelCard}>
          <Text style={styles.text}>No workflow runs yet.</Text>
          <Text style={styles.mutedText}>
            Ask this agent to "use a workflow" for a task. It writes a script with agent(), parallel() and pipeline(), and the
            run shows up here and as a card in the chat.
          </Text>
        </View>
      ) : null}
      {runs.length > 1 ? <RunList runs={runs} selected={runId} onSelect={setSelected} styles={styles} theme={theme} /> : null}
      {runId ? <RunView runId={runId} styles={styles} theme={theme} navigation={navigation} /> : null}
    </ScrollView>
  );
}

function RunList({
  runs,
  selected,
  onSelect,
  styles,
  theme,
}: {
  runs: RunSummary[];
  selected: string | null;
  onSelect: (runId: string) => void;
  styles: Styles;
  theme: PluginTheme;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.sectionTitle}>Runs</Text>
      <View style={styles.list}>
        {runs.map((run, index) => {
          const look = RUN_LOOK[run.status];
          return (
            <View key={run.runId}>
              {index > 0 ? <View style={styles.divider} /> : null}
              <Pressable
                onPress={() => onSelect(run.runId)}
                accessibilityRole="button"
                accessibilityLabel={`Show run ${run.name}`}
                style={[styles.listRow, run.runId === selected ? styles.listRowSelected : null]}
              >
                <View style={styles.between}>
                  <Text style={styles.title} numberOfLines={1}>
                    {run.name}
                  </Text>
                  <Text style={[styles.status, { color: toneColor(theme, look.tone) }]}>
                    {look.glyph} {look.label}
                  </Text>
                </View>
                <Text style={styles.muted} numberOfLines={1}>
                  {formatClock(run.startedAt)} · {plural(run.agents.total, "agent")} · {run.runId}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function RunView({ runId, styles, theme, navigation }: { runId: string; styles: Styles; theme: PluginTheme; navigation: Navigation }) {
  const getRun = useRpc(getRunRpc);
  const stopRun = useRpc(stopRunRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const query = useQuery({
    queryKey: [PLUGIN_ID, "run", runId],
    queryFn: () => getRun({ runId }),
    refetchInterval: (state) => (state.state.data?.run && isLiveRun(state.state.data.run.status) ? 1500 : false),
  });
  const run = query.data?.run ?? null;
  const now = useNow(run !== null && isLiveRun(run.status));
  if (query.isPending) return <Text style={styles.mutedText}>Loading run…</Text>;
  if (query.isError) return <Text style={styles.danger}>Could not load the run: {errorMessage(query.error)}</Text>;
  if (!run) return <Text style={styles.mutedText}>Run {runId} is not on this host.</Text>;

  const look = RUN_LOOK[run.status];
  const stop = async () => {
    setStopping(true);
    try {
      const result = await stopRun({ runId });
      toast.show(result.message);
      await queryClient.invalidateQueries({ queryKey: [PLUGIN_ID] });
    } catch (error) {
      toast.error(`Could not stop the workflow: ${errorMessage(error)}`);
    } finally {
      setStopping(false);
    }
  };

  return (
    <View style={{ gap: 14 }}>
      <View style={styles.panelCard}>
        <View style={styles.between}>
          <Text style={styles.heading} numberOfLines={1}>
            {run.name}
          </Text>
          <Text style={[styles.status, { color: toneColor(theme, look.tone), fontSize: 13 }]}>
            {look.glyph} {look.label} · {elapsed(run.startedAt, run.endedAt, now)}
          </Text>
        </View>
        <Text style={styles.text}>{run.description}</Text>
        <Text style={styles.muted}>
          Started {formatClock(run.startedAt)} · {plural(run.agents.total, "agent")}
          {run.agents.cached ? ` (${run.agents.cached} cached)` : ""} · {formatTokens(run.usage.outputTokens)} output tokens
          {run.budget.total !== null ? ` of ${formatTokens(run.budget.total)}` : ""}
          {run.usage.costUsd > 0 ? ` · $${run.usage.costUsd.toFixed(2)}` : ""}
          {run.resumedFrom ? ` · resumed from ${run.resumedFrom}` : ""}
        </Text>
        {run.error ? (
          <Text style={styles.danger} selectable>
            {run.error}
          </Text>
        ) : null}
        {run.status === "running" ? (
          <View style={styles.row}>
            <Pressable
              onPress={() => void stop()}
              disabled={stopping}
              style={styles.button}
              accessibilityRole="button"
              accessibilityLabel="Stop this workflow"
            >
              <Text style={styles.buttonDangerText}>{stopping ? "Stopping…" : "Stop run"}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <Phases run={run} styles={styles} theme={theme} now={now} navigation={navigation} />

      {run.status === "completed" && run.resultPreview !== null ? (
        <View style={{ gap: 6 }}>
          <View style={styles.between}>
            <Text style={styles.sectionTitle}>Result</Text>
            <CopyButton text={run.resultPreview} label="Copy result" styles={styles} />
          </View>
          <View style={styles.panelCard}>
            <Text style={styles.resultText} selectable>
              {run.resultPreview}
            </Text>
          </View>
        </View>
      ) : null}

      {run.logs.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.sectionTitle}>Log</Text>
          <View style={styles.panelCard}>
            {run.logs.map((line, index) => (
              <Text key={`${line.at}-${index}`} style={styles.text} selectable>
                <Text style={styles.muted}>{formatClock(line.at)} </Text>
                {line.message}
              </Text>
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ gap: 6 }}>
        <Text style={styles.sectionTitle}>Files</Text>
        <View style={styles.panelCard}>
          <PathRow label="Run id" value={run.runId} styles={styles} />
          <PathRow label="Script" value={run.scriptPath} styles={styles} />
          <PathRow label="Run dir" value={run.runDir} styles={styles} />
          {run.resultPath ? <PathRow label="Result" value={run.resultPath} styles={styles} /> : null}
        </View>
      </View>
    </View>
  );
}

function Phases({
  run,
  styles,
  theme,
  now,
  navigation,
}: {
  run: RunDetail;
  styles: Styles;
  theme: PluginTheme;
  now: number;
  navigation: Navigation;
}) {
  const groups = useMemo(() => {
    const byPhase = new Map<string, AgentCall[]>();
    for (const call of run.calls) {
      const title = call.phase ?? UNGROUPED;
      const list = byPhase.get(title) ?? [];
      list.push(call);
      byPhase.set(title, list);
    }
    return run.phases.map((phase) => ({ phase, calls: byPhase.get(phase.title) ?? [] }));
  }, [run.calls, run.phases]);
  if (groups.length === 0) return <Text style={styles.mutedText}>No agents yet.</Text>;
  return (
    <View style={{ gap: 10 }}>
      {groups.map(({ phase, calls }) => (
        <View key={phase.title} style={{ gap: 6 }}>
          <View style={styles.between}>
            <Text style={styles.sectionTitle}>{phase.title}</Text>
            <Text style={styles.muted}>
              {phase.total === 0 ? "not started" : `${phase.done}/${phase.total} done`}
              {phase.running ? ` · ${phase.running} active` : ""}
              {phase.failed ? ` · ${phase.failed} failed` : ""}
            </Text>
          </View>
          {phase.detail ? <Text style={styles.muted}>{phase.detail}</Text> : null}
          {calls.length > 0 ? (
            <View style={styles.panelCard}>
              {calls.slice(0, CALLS_PER_PHASE).map((call) => (
                <CallRow key={call.callId} runId={run.runId} call={call} styles={styles} theme={theme} now={now} navigation={navigation} />
              ))}
              {calls.length > CALLS_PER_PHASE ? (
                <Text style={styles.muted}>+{calls.length - CALLS_PER_PHASE} more agents in this phase</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function CallRow({
  runId,
  call,
  styles,
  theme,
  now,
  navigation,
}: {
  runId: string;
  call: AgentCall;
  styles: Styles;
  theme: PluginTheme;
  now: number;
  navigation: Navigation;
}) {
  const [open, setOpen] = useState(false);
  const skipCall = useRpc(skipCallRpc);
  const toast = useToast();
  const look = CALL_LOOK[call.status];
  const live = isLiveCall(call.status);
  const time = elapsed(call.startedAt, call.endedAt, now);
  const skip = async () => {
    try {
      const result = await skipCall({ runId, callId: call.callId });
      toast.show(result.message);
    } catch (error) {
      toast.error(`Could not skip the agent: ${errorMessage(error)}`);
    }
  };
  return (
    <View style={styles.callRow}>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={`${call.label}, ${look.label}. Show details`}
        style={styles.agentRow}
      >
        <Text style={[styles.glyph, { color: toneColor(theme, look.tone) }]}>{look.glyph}</Text>
        <Text style={styles.agentLabel} numberOfLines={1}>
          {call.label}
        </Text>
        <Text style={styles.callMeta} numberOfLines={1}>
          {look.label}
          {time ? ` · ${time}` : ""}
          {call.usage.outputTokens ? ` · ${formatTokens(call.usage.outputTokens)}` : ""}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.callDetail}>
          <Text style={styles.muted} selectable>
            {[call.provider && call.model ? `${call.provider}/${call.model}` : call.provider, call.agentId ? `agent ${call.agentId}` : null, call.repairs ? `${plural(call.repairs, "schema correction")}` : null]
              .filter(Boolean)
              .join(" · ") || "not started"}
          </Text>
          {call.worktree ? (
            <Text style={styles.muted} selectable>
              Worktree {call.worktree.path}
              {call.worktree.branch ? ` · branch ${call.worktree.branch}` : ""}
              {call.worktree.changed === true ? " · has changes" : call.worktree.changed === false ? " · unchanged, removed" : ""}
            </Text>
          ) : null}
          {call.error ? (
            <Text style={styles.danger} selectable>
              {call.error}
            </Text>
          ) : null}
          {call.resultPreview !== null ? (
            <Text style={styles.resultText} selectable>
              {call.resultPreview}
            </Text>
          ) : null}
          <View style={styles.row}>
            {call.agentId && navigation ? (
              <Pressable
                onPress={() => navigation.openAgent({ agentId: call.agentId ?? "" })}
                style={styles.button}
                accessibilityRole="button"
                accessibilityLabel={`Open agent ${call.label}`}
              >
                <Text style={styles.buttonText}>Open agent</Text>
              </Pressable>
            ) : null}
            {live ? (
              <Pressable onPress={() => void skip()} style={styles.button} accessibilityRole="button" accessibilityLabel={`Skip ${call.label}`}>
                <Text style={styles.buttonDangerText}>Skip</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function PathRow({ label, value, styles }: { label: string; value: string; styles: Styles }) {
  return (
    <View style={styles.pathRow}>
      <Text style={styles.pathLabel}>{label}</Text>
      <Text style={styles.pathValue} numberOfLines={1} selectable>
        {value}
      </Text>
      <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} styles={styles} />
    </View>
  );
}

function CopyButton({ text, label, styles }: { text: string; label: string; styles: Styles }) {
  const toast = useToast();
  return (
    <Pressable
      onPress={() =>
        void copyText(text).then(
          () => toast.show("Copied"),
          (error) => toast.error(`Could not copy: ${errorMessage(error)}`),
        )
      }
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
    >
      <Text style={styles.link}>Copy</Text>
    </Pressable>
  );
}

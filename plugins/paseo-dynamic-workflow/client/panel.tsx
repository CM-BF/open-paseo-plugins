import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginAgentPanelProps, useAgent, useRpc } from "@getpaseo/plugin/client";
import { copyText, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { getCallRpc, getRunRpc, listRunsRpc, restartCallRpc, skipCallRpc, stopRunRpc, transcriptRpc } from "../shared/contracts";
import { PLUGIN_ID } from "../shared/ids";
import type { TranscriptEntry } from "../shared/contracts";
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
import { callsByAttention } from "./call-order";
import { AgentAccess } from "./agent-access";

const CALLS_PER_PAGE = 50;
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
      <AgentAccess key={agentId} agentId={agentId} styles={styles} />
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
            Enable workflow tools above and ask this agent to "use a workflow" (or put "ultracode" in a message); with Ultracode on it starts workflows for
            substantive tasks by itself. It writes a script with agent(), parallel() and pipeline(), and the run shows up here and as a card in the chat.
          </Text>
        </View>
      ) : null}
      {runs.length > 1 ? <RunList runs={runs} selected={runId} onSelect={setSelected} styles={styles} theme={theme} /> : null}
      {runId ? <RunView key={runId} runId={runId} styles={styles} theme={theme} navigation={navigation} /> : null}
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
                  {formatClock(run.startedAt)} · {plural(run.agents.total, "agent")}
                  {run.agents.failed ? ` · ${run.agents.failed} failed` : ""} · {run.runId}
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
    queryFn: () => getRun({ runId, compact: true }),
    refetchInterval: (state) => (state.state.data?.run && isLiveRun(state.state.data.run.status) ? 1500 : false),
  });
  const run = query.data?.run ?? null;
  if (query.isPending) return <Text style={styles.mutedText}>Loading run…</Text>;
  if (query.isError) return <Text style={styles.danger}>Could not load the run: {errorMessage(query.error)}</Text>;
  if (!run) return <Text style={styles.mutedText}>Run {runId} is not on this host.</Text>;

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
          <RunStatus run={run} styles={styles} theme={theme} />
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

      <Phases run={run} styles={styles} theme={theme} navigation={navigation} />

      {run.status === "completed" && run.resultPreview !== null ? (
        <View style={{ gap: 6 }}>
          <View style={styles.between}>
            <Text style={styles.sectionTitle}>Result</Text>
            <CopyButton text={run.resultPreview} label="Copy result" styles={styles} />
          </View>
          <View style={styles.panelCard}>
            <Text style={styles.resultText} selectable>
              {prettyJson(run.resultPreview)}
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
          <PathRow label="Journal" value={run.journalPath} styles={styles} />
          {run.resultPath ? <PathRow label="Result" value={run.resultPath} styles={styles} /> : null}
        </View>
      </View>
    </View>
  );
}

/** Its clock updates without re-rendering the call list. */
function RunStatus({ run, styles, theme }: { run: RunSummary; styles: Styles; theme: PluginTheme }) {
  const now = useNow(isLiveRun(run.status));
  const look = RUN_LOOK[run.status];
  return (
    <Text style={[styles.status, { color: toneColor(theme, look.tone), fontSize: 13 }]}>
      {look.glyph} {look.label} · {elapsed(run.startedAt, run.endedAt, now)}
    </Text>
  );
}

const Phases = memo(function Phases({
  run,
  styles,
  theme,
  navigation,
}: {
  run: RunDetail;
  styles: Styles;
  theme: PluginTheme;
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
    return run.phases.map((phase) => ({ phase, calls: callsByAttention(byPhase.get(phase.title) ?? []) }));
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
              {phase.running ? ` · ${phase.running} running` : ""}
              {phase.queued ? ` · ${phase.queued} queued` : ""}
              {phase.failed ? ` · ${phase.failed} failed` : ""}
              {phase.skipped ? ` · ${phase.skipped} skipped` : ""}
            </Text>
          </View>
          {phase.detail ? <Text style={styles.muted}>{phase.detail}</Text> : null}
          {calls.length > 0 ? <PhaseCalls runId={run.runId} calls={calls} styles={styles} theme={theme} navigation={navigation} /> : null}
        </View>
      ))}
    </View>
  );
});

function PhaseCalls({ runId, calls, styles, theme, navigation }: {
  runId: string;
  calls: AgentCall[];
  styles: Styles;
  theme: PluginTheme;
  navigation: Navigation;
}) {
  const [visible, setVisible] = useState(CALLS_PER_PAGE);
  return (
    <View style={styles.panelCard}>
      {calls.slice(0, visible).map((call) => (
        <CallRow key={call.callId} runId={runId} call={call} styles={styles} theme={theme} navigation={navigation} />
      ))}
      {calls.length > visible ? (
        <Pressable onPress={() => setVisible((count) => count + CALLS_PER_PAGE)} accessibilityRole="button" style={styles.button}>
          <Text style={styles.buttonText}>Show {Math.min(CALLS_PER_PAGE, calls.length - visible)} more · {calls.length - visible} remaining</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const CallRow = memo(function CallRow({
  runId,
  call,
  styles,
  theme,
  navigation,
}: {
  runId: string;
  call: AgentCall;
  styles: Styles;
  theme: PluginTheme;
  navigation: Navigation;
}) {
  const [open, setOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const queryClient = useQueryClient();
  const skipCall = useRpc(skipCallRpc);
  const restartCall = useRpc(restartCallRpc);
  const [restarting, setRestarting] = useState(false);
  const toast = useToast();
  const look = CALL_LOOK[call.status];
  const live = isLiveCall(call.status);
  const now = useNow(live && call.startedAt !== null);
  const time = elapsed(call.startedAt, call.endedAt, now);
  useEffect(() => { if (!live) setSkipping(false); }, [live]);
  useEffect(() => { setRestarting(false); }, [call.attempt, live]);
  const restart = async () => {
    setRestarting(true);
    try {
      const result = await restartCall({ runId, callId: call.callId });
      toast.show(result.message);
      if (!result.restarted) setRestarting(false);
      await queryClient.invalidateQueries({ queryKey: [PLUGIN_ID, "run", runId] });
    } catch (error) {
      setRestarting(false);
      toast.error(`Could not restart the agent: ${errorMessage(error)}`);
    }
  };
  const skip = async () => {
    setSkipping(true);
    try {
      const result = await skipCall({ runId, callId: call.callId });
      toast.show(result.message);
      if (!result.skipped) setSkipping(false);
      await queryClient.invalidateQueries({ queryKey: [PLUGIN_ID, "run", runId] });
    } catch (error) {
      setSkipping(false);
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
          {call.attempt ? ` · attempt ${call.attempt}` : ""}
          {call.toolCalls ? ` · ${plural(call.toolCalls, "tool")}${call.lastTool ? `, last ${call.lastTool}` : ""}` : ""}
          {call.usage.outputTokens ? ` · ${formatTokens(call.usage.outputTokens)} tok` : ""}
        </Text>
      </Pressable>
      {open ? <CallDetails runId={runId} call={call} styles={styles} theme={theme} navigation={navigation} skipping={skipping} onSkip={skip} restarting={restarting} onRestart={restart} /> : null}

    </View>
  );
});

function CallDetails({ runId, call, styles, theme, navigation, skipping, onSkip, restarting, onRestart }: {
  runId: string;
  call: AgentCall;
  styles: Styles;
  theme: PluginTheme;
  navigation: Navigation;
  skipping: boolean;
  onSkip: () => Promise<void>;
  restarting: boolean;
  onRestart: () => Promise<void>;
}) {
  const [showTranscript, setShowTranscript] = useState(false);
  const live = isLiveCall(call.status);
  // Only expanded rows need client-cache subscriptions or full result/error queries.
  const openable = useAgent(call.agentId ?? "", (snapshot) => ({ id: snapshot.id })) !== null;
  const getCall = useRpc(getCallRpc);
  const details = useQuery({
    queryKey: [PLUGIN_ID, "call", runId, call.callId, call.status],
    queryFn: () => getCall({ runId, callId: call.callId }),
    refetchInterval: live ? 3000 : false,
  });
  const detail = details.data?.call ?? call;
  return (
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
          {call.promptPreview ? (
            <Text style={styles.muted} numberOfLines={3} selectable>
              Task: {call.promptPreview}
            </Text>
          ) : null}
          {details.isPending ? <Text style={styles.muted}>Loading details…</Text> : null}
          {details.isError ? <Text style={styles.danger}>Could not load details: {errorMessage(details.error)}</Text> : null}
          {detail.error ? (
            <Text style={styles.danger} selectable>
              {detail.error}
            </Text>
          ) : null}
          {detail.resultPreview !== null ? (
            <Text style={styles.resultText} selectable>
              {prettyJson(detail.resultPreview)}
            </Text>
          ) : null}
          <View style={styles.row}>
            {call.agentId ? (
              <Pressable
                onPress={() => setShowTranscript((value) => !value)}
                style={styles.button}
                accessibilityRole="button"
                accessibilityLabel={`${showTranscript ? "Hide" : "Show"} the transcript of ${call.label}`}
              >
                <Text style={styles.buttonText}>{showTranscript ? "Hide transcript" : "Transcript"}</Text>
              </Pressable>
            ) : null}
            {call.agentId && navigation && openable ? (
              <Pressable
                onPress={() => navigation.openAgent({ agentId: call.agentId ?? "" })}
                style={styles.button}
                accessibilityRole="button"
                accessibilityLabel={`Open agent ${call.label}`}
              >
                <Text style={styles.buttonText}>Open agent</Text>
              </Pressable>
            ) : null}
            {live && call.status !== "queued" ? (
              <Pressable onPress={() => void onRestart()} disabled={restarting || skipping} style={styles.button} accessibilityRole="button" accessibilityLabel={`Restart ${call.label}`}>
                <Text style={styles.buttonText}>{restarting ? "Restarting…" : "Restart"}</Text>
              </Pressable>
            ) : null}
            {live ? (
              <Pressable onPress={() => void onSkip()} disabled={skipping} style={styles.button} accessibilityRole="button" accessibilityLabel={`Skip ${call.label}`}>
                <Text style={styles.buttonDangerText}>{skipping ? "Skipping…" : "Skip"}</Text>
              </Pressable>
            ) : null}
          </View>
          {showTranscript && call.agentId ? <Transcript agentId={call.agentId} live={live} styles={styles} theme={theme} /> : null}
        </View>
  );
}

const ENTRY_LOOK: Record<TranscriptEntry["kind"], { prefix: string; tone: "muted" | "accent" | "danger" | "success" }> = {
  user: { prefix: "prompt", tone: "muted" },
  assistant: { prefix: "reply", tone: "success" },
  tool: { prefix: "tool", tone: "accent" },
  error: { prefix: "error", tone: "danger" },
};

function Transcript({ agentId, live, styles, theme }: { agentId: string; live: boolean; styles: Styles; theme: PluginTheme }) {
  const readTranscript = useRpc(transcriptRpc);
  const query = useQuery({
    queryKey: [PLUGIN_ID, "transcript", agentId],
    queryFn: () => readTranscript({ agentId }),
    refetchInterval: live ? 3000 : false,
  });
  const wasLive = useRef(live);
  const { refetch } = query;
  useEffect(() => {
    if (wasLive.current && !live) void refetch();
    wasLive.current = live;
  }, [live, refetch]);
  if (query.isPending) return <Text style={styles.muted}>Loading transcript…</Text>;
  if (query.isError) return <Text style={styles.danger}>Could not load the transcript: {errorMessage(query.error)}</Text>;
  return (
    <View style={{ gap: 4 }}>
      <Pressable onPress={() => void refetch()} accessibilityRole="button"><Text style={styles.link}>Refresh transcript</Text></Pressable>
      {query.data.entries.length === 0 ? <Text style={styles.muted}>No transcript entries available yet.</Text> : null}
      {query.data.truncated ? <Text style={styles.muted}>Showing the last {query.data.entries.length} entries</Text> : null}
      {query.data.entries.map((entry, index) => {
        const look = ENTRY_LOOK[entry.kind];
        return (
          <Text key={index} style={styles.text} selectable numberOfLines={entry.kind === "user" ? 4 : undefined}>
            <Text style={[styles.muted, { color: toneColor(theme, look.tone) }]}>
              {look.prefix}
              {entry.status && entry.status !== "completed" ? ` (${entry.status})` : ""}{" "}
            </Text>
            {entry.text}
          </Text>
        );
      })}
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

/** Indented JSON when the text is complete JSON; the text as it is otherwise (strings, truncated values). */
function prettyJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

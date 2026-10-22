import { type PluginTimelineItemProps, useAgent, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { stopRunRpc } from "../shared/contracts";
import { PANEL_ID } from "../shared/ids";
import type { CardData, PhaseSummary } from "../shared/run-types";
import { CALL_LOOK, elapsed, errorMessage, formatTokens, isLiveRun, plural, RUN_LOOK, toneColor } from "./format";
import { getClient, requestRun, useNow } from "./hooks";
import { createStyles, type Styles } from "./styles";

/** The live run row the daemon appends to the launching agent's timeline. */
export function RunCard({ agentId, item, theme, layout }: PluginTimelineItemProps<CardData>) {
  const data = item.data;
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const live = isLiveRun(data.status);
  const now = useNow(live);
  const agent = useAgent(agentId, (snapshot) => ({ workspaceId: snapshot.workspaceId }));
  const stopRun = useRpc(stopRunRpc);
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const look = RUN_LOOK[data.status];
  const duration = elapsed(data.startedAt, data.endedAt, now);

  const openDetails = agent?.workspaceId
    ? () => {
        const client = getClient();
        if (!client) return;
        requestRun(agentId, data.runId);
        try {
          client.openPanel(PANEL_ID, { workspaceId: agent.workspaceId, agentId });
        } catch (error) {
          toast.error(`Could not open the workflow panel: ${errorMessage(error)}`);
        }
      }
    : undefined;

  const stop = async () => {
    setStopping(true);
    try {
      const result = await stopRun({ runId: data.runId });
      toast.show(result.message);
    } catch (error) {
      toast.error(`Could not stop the workflow: ${errorMessage(error)}`);
    } finally {
      setStopping(false);
    }
  };

  return (
    <View style={styles.card} accessibilityLabel={`Dynamic workflow ${data.name}, ${look.label}`}>
      <View style={styles.between}>
        <View style={[styles.row, styles.grow]}>
          <Text style={styles.kicker}>Workflow ·</Text>
          <Text style={styles.title} numberOfLines={1}>
            {data.name}
          </Text>
        </View>
        <Text style={[styles.status, { color: toneColor(theme, look.tone) }]}>
          {look.glyph} {look.label}
          {duration ? ` · ${duration}` : ""}
        </Text>
      </View>
      <Text style={styles.text} numberOfLines={2}>
        {data.description}
      </Text>
      {data.phases.filter((phase) => phase.total > 0 || live).map((phase) => (
        <PhaseBar key={phase.title} phase={phase} styles={styles} />
      ))}
      {data.active.length > 0 ? (
        <View style={styles.agents}>
          {data.active.map((call) => {
            const callLook = CALL_LOOK[call.status];
            return (
              <View key={call.callId} style={styles.agentRow}>
                <Text style={[styles.glyph, { color: toneColor(theme, callLook.tone) }]}>{callLook.glyph}</Text>
                <Text style={styles.agentLabel} numberOfLines={1}>
                  {call.label}
                </Text>
                <Text style={styles.muted}>
                  {call.status === "permission" ? "needs permission · " : ""}
                  {elapsed(call.startedAt, null, now) ?? callLook.label}
                </Text>
              </View>
            );
          })}
          {data.agents.running > data.active.length ? (
            <Text style={styles.muted}>+{data.agents.running - data.active.length} more running</Text>
          ) : null}
        </View>
      ) : null}
      {data.agents.queued > 0 ? <Text style={styles.muted}>{data.agents.queued} queued</Text> : null}
      {data.logs.length > 0 && live ? (
        <Text style={styles.log} numberOfLines={2}>
          › {data.logs[data.logs.length - 1]}
        </Text>
      ) : null}
      {data.error ? (
        <Text style={styles.danger} numberOfLines={4}>
          {data.error}
        </Text>
      ) : null}
      {data.resultPreview !== null && data.status === "completed" ? <ResultPreview text={data.resultPreview} styles={styles} /> : null}
      <View style={styles.footer}>
        <View style={styles.actions}>
          {openDetails ? (
            <Pressable onPress={openDetails} accessibilityRole="button" accessibilityLabel="Open workflow details" hitSlop={8}>
              <Text style={styles.link}>Details</Text>
            </Pressable>
          ) : null}
          {data.status === "running" ? (
            <Pressable
              onPress={() => void stop()}
              disabled={stopping}
              accessibilityRole="button"
              accessibilityLabel="Stop this workflow"
              hitSlop={8}
            >
              <Text style={styles.linkDanger}>{stopping ? "Stopping…" : "Stop"}</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={[styles.muted, styles.shrink]} numberOfLines={1}>
          {summaryLine(data)}
        </Text>
      </View>
    </View>
  );
}

function summaryLine(data: CardData): string {
  const parts = [plural(data.agents.total, "agent")];
  if (data.agents.cached > 0) parts.push(`${data.agents.cached} cached`);
  if (data.agents.failed > 0) parts.push(`${data.agents.failed} failed`);
  if (data.agents.skipped > 0) parts.push(`${data.agents.skipped} skipped`);
  if (data.usage.outputTokens > 0) parts.push(`${formatTokens(data.usage.outputTokens)} out`);
  return parts.join(" · ");
}

function PhaseBar({ phase, styles }: { phase: PhaseSummary; styles: Styles }) {
  const total = Math.max(phase.total, 1);
  const pct = (count: number) => `${Math.round((count / total) * 100)}%` as const;
  const count =
    phase.total === 0
      ? "waiting"
      : `${phase.done}/${phase.total}${phase.running ? ` · ${phase.running} running` : ""}${phase.queued ? ` · ${phase.queued} queued` : ""}${phase.failed ? ` · ${phase.failed} failed` : ""}${phase.skipped ? ` · ${phase.skipped} skipped` : ""}`;
  return (
    <View style={styles.phaseRow} accessibilityLabel={`Phase ${phase.title}: ${count}`}>
      <Text style={styles.phaseTitle} numberOfLines={1}>
        {phase.title}
      </Text>
      <View style={styles.bar}>
        <View style={[styles.barDone, { width: pct(phase.done) }]} />
        <View style={[styles.barFailed, { width: pct(phase.failed) }]} />
        <View style={[styles.barSkipped, { width: pct(phase.skipped) }]} />
        <View style={[styles.barRunning, { width: pct(phase.running), opacity: 0.55 }]} />
      </View>
      <Text style={styles.phaseCount} numberOfLines={1}>
        {count}
      </Text>
    </View>
  );
}

function ResultPreview({ text, styles }: { text: string; styles: Styles }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((value) => !value)} accessibilityRole="button" accessibilityLabel="Show or hide the result">
      <View style={styles.result}>
        <Text style={styles.muted}>Result {open ? "▾" : "▸"}</Text>
        <Text style={styles.resultText} numberOfLines={open ? undefined : 2} selectable>
          {text}
        </Text>
      </View>
    </Pressable>
  );
}


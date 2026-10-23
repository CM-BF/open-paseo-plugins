import { type PluginTimelineItemProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { PLUGIN_ID, SCREEN_HOME } from "../shared/ids";
import { alertStatusRpc, updateAlertRpc } from "../shared/rpc";
import type { Alert } from "../shared/types";
import type { UpdateRow } from "../shared/update";
import { getClient } from "./client-ref";
import { errorMessage, toneColor, urgencyTone } from "./format";
import { useAction } from "./queries";
import { createStyles } from "./styles";

const LOOK: Record<UpdateRow["kind"], { icon: string; label: string }> = {
  checkin: { icon: "Radar", label: "Background check-in" },
  brief: { icon: "Sunrise", label: "Brief" },
  reminder: { icon: "AlarmClock", label: "Reminder" },
  welcome: { icon: "Sparkles", label: "Setup" },
};

const STATUS_LABEL: Record<Alert["status"], string> = { open: "", done: "Done", snoozed: "Snoozed", muted: "Won't remind" };

/**
 * Replaces the plugin's note to the assistant with a compact card: what triggered the message the
 * assistant writes next, with buttons to answer each alert without typing.
 */
export function UpdateCard({ item, theme, layout }: PluginTimelineItemProps<UpdateRow>) {
  const data = item.data;
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const [open, setOpen] = useState(false);
  const look = LOOK[data.kind];
  const ids = data.items.map((entry) => entry.id);
  const readAlerts = useRpc(alertStatusRpc);
  const alerts = useQuery({ queryKey: [PLUGIN_ID, "alerts", ...ids], queryFn: () => readAlerts({ ids }), enabled: ids.length > 0, staleTime: 15_000 });
  const statusOf = (id: string) => alerts.data?.alerts.find((alert) => alert.id === id)?.status ?? null;
  return (
    <View style={[styles.card, { paddingHorizontal: layout.compact ? 10 : 12, paddingVertical: 8, gap: 6 }]}>
      <View style={styles.between}>
        <View style={[styles.row, styles.grow]}>
          <Icon name={look.icon} size={15} color={theme.colors.accent} />
          <Text style={[styles.text, { fontWeight: "600", flexShrink: 1 }]} numberOfLines={1}>
            {look.label}
            {data.kind === "checkin" || data.kind === "reminder" ? ` · ${data.title}` : ""}
          </Text>
        </View>
        <View style={styles.row}>
          <Pressable accessibilityRole="button" accessibilityLabel={open ? "Hide the note" : "Show the note the assistant received"} hitSlop={8} onPress={() => setOpen((value) => !value)}>
            <Text style={styles.link}>{open ? "Hide" : "Note"}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Open Aide" hitSlop={8} onPress={() => getClient()?.openScreen({ screenId: SCREEN_HOME })}>
            <Text style={styles.link}>Aide</Text>
          </Pressable>
        </View>
      </View>
      {data.items.length > 0 ? (
        <View style={{ gap: 6 }}>
          {data.items.map((entry) => (
            <AlertLine key={entry.id} id={entry.id} title={entry.title} urgency={entry.urgency} status={statusOf(entry.id)} styles={styles} theme={theme} />
          ))}
        </View>
      ) : null}
      <Text style={styles.muted}>Sent by Aide to its assistant, not by you</Text>
      {open ? (
        <Text style={styles.mono} selectable>
          {data.body}
        </Text>
      ) : null}
    </View>
  );
}

function AlertLine({ id, title, urgency, status, styles, theme }: { id: string; title: string; urgency: Alert["urgency"]; status: Alert["status"] | null; styles: ReturnType<typeof createStyles>; theme: PluginTimelineItemProps["theme"] }) {
  const update = useAction(useRpc(updateAlertRpc));
  const toast = useToast();
  const act = (action: "done" | "snooze" | "mute", until?: string) =>
    void update.mutateAsync({ id, action, ...(until ? { until } : {}) }).then(
      (result) => toast.show(result.message, { variant: "success" }),
      (error) => toast.error(errorMessage(error)),
    );
  const settled = status !== null && status !== "open";
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: toneColor(theme, urgencyTone(urgency)) }]} />
        <Text style={[styles.text, { flexShrink: 1 }, settled ? { textDecorationLine: status === "done" ? "line-through" : "none", opacity: 0.7 } : null]}>{title}</Text>
      </View>
      {settled ? (
        <Text style={[styles.muted, { paddingLeft: 14 }]}>{STATUS_LABEL[status]}</Text>
      ) : status === "open" ? (
        <View style={[styles.wrap, { paddingLeft: 14 }]}>
          {(
            [
              ["Done", () => act("done")],
              ["Later", () => act("snooze", "in 3h")],
              ["Don't remind me", () => act("mute")],
            ] as const
          ).map(([label, onPress]) => (
            <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label}: ${title}`} disabled={update.isPending} onPress={onPress} style={[styles.small, update.isPending ? { opacity: 0.5 } : null]}>
              <Text style={styles.smallText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

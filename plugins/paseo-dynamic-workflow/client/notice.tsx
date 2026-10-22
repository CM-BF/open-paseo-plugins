import { type PluginTimelineItemProps, useAgent } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { PANEL_ID } from "../shared/ids";
import type { NoticeData } from "../shared/notification";
import type { RunStatus } from "../shared/run-types";
import { RUN_LOOK, toneColor } from "./format";
import { getClient, requestRun } from "./hooks";
import { createStyles } from "./styles";

/** Replaces the plugin's task-notification prompt in the chat with one compact row. */
export function NoticeRow({ agentId, item, theme, layout }: PluginTimelineItemProps<NoticeData>) {
  const data = item.data;
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const agent = useAgent(agentId, (snapshot) => ({ workspaceId: snapshot.workspaceId }));
  const [open, setOpen] = useState(false);
  const look = RUN_LOOK[data.status as RunStatus] ?? RUN_LOOK.completed;
  const openRun = () => {
    const client = getClient();
    if (!client || !agent?.workspaceId) return;
    requestRun(agentId, data.runId);
    client.openPanel(PANEL_ID, { workspaceId: agent.workspaceId, agentId });
  };
  return (
    <View style={[styles.card, { paddingVertical: 6 }]}>
      <View style={styles.between}>
        <View style={[styles.row, styles.grow]}>
          <Text style={[styles.status, { color: toneColor(theme, look.tone) }]}>{look.glyph}</Text>
          <Text style={[styles.text, styles.shrink]} numberOfLines={1}>
            {data.summary}
          </Text>
        </View>
        <View style={styles.actions}>
          <Pressable onPress={() => setOpen((value) => !value)} accessibilityRole="button" accessibilityLabel="Show the notification sent to the agent" hitSlop={8}>
            <Text style={styles.link}>{open ? "Hide message" : "Message"}</Text>
          </Pressable>
          {agent?.workspaceId ? (
            <Pressable onPress={openRun} accessibilityRole="button" accessibilityLabel="Open this workflow run" hitSlop={8}>
              <Text style={styles.link}>Run</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <Text style={styles.muted}>Result delivered to the agent by paseo-dynamic-workflow · {data.runId}</Text>
      {open ? (
        <Text style={styles.resultText} selectable>
          {data.text}
        </Text>
      ) : null}
    </View>
  );
}

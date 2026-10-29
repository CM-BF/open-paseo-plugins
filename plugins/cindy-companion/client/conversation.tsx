import { useLayoutEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useSettingsInvoke } from "./data";

/** Compatibility route for hosts before sidebar navigation became public. */
export function CompanionConversation(props: PluginScreenProps) {
  const invoke = useSettingsInvoke(props.host.id);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => {
    let disposed = false;
    setError("");
    async function open() {
      if (!props.navigation?.openAgent) throw new Error("This Paseo app cannot open an agent from a plugin. Update the desktop app to continue.");
      let agentId = props.params.agentId;
      if (!agentId) {
        const result = await invoke("paseo.conversation.ensure", { botId: props.params.botId ?? "cindy" });
        if (!result.ok) throw new Error(result.message);
        agentId = (result.value as { agentId: string }).agentId;
      }
      if (!disposed) props.navigation.openAgent({ agentId, serverId: props.host.id });
    }
    void open().catch(error => { if (!disposed) setError(error instanceof Error ? error.message : "Could not open teammate"); });
    return () => { disposed = true; };
  }, [attempt, invoke, props.host.id, props.navigation, props.params.agentId, props.params.botId]);
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12, backgroundColor: props.theme.colors.surface0 }}>
    {error ? <>
      <Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger }}>{error}</Text>
      <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={{ padding: 12 }}>
        <Text style={{ color: props.theme.colors.foreground }}>Try again</Text>
      </Pressable>
    </> : <><ActivityIndicator color={props.theme.colors.foregroundMuted} /><Text style={{ color: props.theme.colors.foregroundMuted }}>Opening teammate…</Text></>}
  </View>;
}

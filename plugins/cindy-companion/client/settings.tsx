import { useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { SETTINGS_HTML } from "./generated/settings-html";
import { canRenderSettingsFrame, SettingsBackdrop, SettingsFrame, type SettingsFrameHandle } from "./web";
import { appearanceFromBackground } from "./frame-protocol";
import { companionsKey, useSettingsInvoke } from "./data";

export interface SettingsProps extends PluginHostProps {
  botId: string;
  view?: 'settings' | 'presets' | 'teammate-create' | 'group-create';
  onClose(): void;
  onNavigateAgent(agentId: string): void;
  onNavigateGroup?(groupId: string): void;
}

export function CompanionSettings(props: SettingsProps) {
  const handle = useRef<SettingsFrameHandle | null>(null);
  const [ready, setReady] = useState(false);
  const invoke = useSettingsInvoke(props.host.id);
  const queries = useQueryClient();
  const changed = () => { void queries.invalidateQueries({ queryKey: companionsKey(props.host.id) }); };
  const close = () => { changed(); props.onClose(); };
  const requestClose = () => handle.current ? handle.current.requestClose() : close();
  const dark = appearanceFromBackground(props.theme.colors.surface0) === "dark";
  const dialog = props.view === 'presets' || props.view === 'group-create' || props.view === 'teammate-create';
  return (
    <Modal transparent visible animationType="none" onRequestClose={requestClose} statusBarTranslucent>
      <View style={{ flex: 1, flexDirection: "row", justifyContent: "flex-end" }}>
        {canRenderSettingsFrame ? <SettingsBackdrop onPress={requestClose} /> : (
          <Pressable accessibilityLabel="Close teammate settings" onPress={requestClose}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,.8)" }} />
        )}
        <View style={{ width: "100%", maxWidth: dialog ? undefined : 448, height: "100%", backgroundColor: dark ? "#181818" : "#ffffff", borderLeftWidth: dialog ? 0 : 1, borderLeftColor: dark ? "#303030" : "#e0e0e0" }}>
          {canRenderSettingsFrame ? <>
            {!ready && <View pointerEvents="none" style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator color={props.theme.colors.foregroundMuted} />
            </View>}
            <SettingsFrame document={SETTINGS_HTML}
              init={{ botId: props.botId, host: props.host, theme: dark ? "dark" : "light", locale: "en", view: props.view }}
              invoke={invoke} onHandle={value => { handle.current = value; }} onReady={() => setReady(true)}
              onChanged={changed} onClose={close} onNavigateAgent={props.onNavigateAgent} onNavigateGroup={props.onNavigateGroup} />
          </> : <View style={{ padding: 24, gap: 20 }}>
            <Text style={{ color: props.theme.colors.foreground, fontSize: 20 }}>Settings</Text>
            <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 15 }}>Cindy’s original settings currently open in Paseo desktop and web. You can continue the teammate’s chat on this device.</Text>
            <Pressable accessibilityRole="button" onPress={close} style={{ paddingVertical: 12 }}>
              <Text style={{ color: props.theme.colors.foreground }}>Back to chat</Text>
            </Pressable>
          </View>}
        </View>
      </View>
    </Modal>
  );
}

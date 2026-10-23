import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { VoiceSettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  // Settings screens get no client context; the speech preview plays through this client.
  const playAudio = (source: { base64: string; mimeType: string }) => client.playAudio(source);
  function SettingsScreen(props: PluginSurfaceProps) {
    return <VoiceSettingsScreen {...props} playAudio={playAudio} />;
  }
  const removers = [
    client.addSettingsScreen({
      id: "settings",
      title: "Gemini 中文语音",
      icon: "Mic",
      Component: SettingsScreen,
    }),
    client.addCommandCenterItem({
      id: "open-settings",
      title: "Gemini 中文语音设置",
      icon: "Mic",
      keywords: ["voice", "dictation", "gemini", "语音", "听写"],
      context: "global",
      onSelect({ openSettings }) {
        openSettings("settings");
      },
    }),
    // Not "/voice": that name belongs to Claude Code, and plugin commands would shadow it.
    client.addSlashCommand({
      name: "gemini-voice",
      description: "打开 Gemini 中文语音设置",
      argumentHint: "",
      context: "agent",
      onSubmit({ openSettings }) {
        openSettings("settings");
      },
    }),
  ];
  return async () => {
    for (const remove of removers.reverse()) await remove();
  };
}

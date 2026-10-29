import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, Text, TextInput, View } from "react-native";
import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import type { CompanionProfile } from "../shared/contracts";
import { avatarPresentation } from "./assets/avatar-presentation";
import { appearanceFromBackground } from "./frame-protocol";
import { useCompanions, useSettingsInvoke } from "./data";
import { CompanionSettings } from "./settings";
import { AvatarContext, canRenderSettingsFrame } from "./web";

type SidebarNavigation = { openAgent(input: { agentId: string; serverId?: string }): void };
export interface TeammatesProps extends PluginSidebarItemProps {
  navigation?: SidebarNavigation;
  /** New hosts supply the focused native agent; older hosts keep click selection. */
  currentAgentId?: string | null;
  onProfiles(profiles: CompanionProfile[]): void;
}

function Avatar({ bot, appearance, foreground }: { bot: CompanionProfile; appearance: "dark" | "light"; foreground: string }) {
  const presentation = avatarPresentation(bot, appearance);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  useEffect(() => { setFailedUri(null); }, [presentation.uri]);
  const uri = presentation.uri !== failedUri ? presentation.uri : null;
  return <View style={{ width: 28, height: 28, borderRadius: 14, overflow: "hidden", backgroundColor: presentation.backgroundColor, justifyContent: "center", alignItems: "center" }}>
    {uri ? <Image accessibilityIgnoresInvertColors source={{ uri }} resizeMode="cover"
      onError={() => setFailedUri(uri)} style={{ width: 28, height: 28, borderRadius: 14 }} />
      : <Text style={{ fontSize: 18, color: foreground }}>{presentation.glyph}</Text>}
  </View>;
}

function CreateTeammate(props: PluginPopoverProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const editorGeneration = useRef(0);
  const creation = useRef<{ name: string; operationId: string } | null>(null);
  useLayoutEffect(() => {
    editorGeneration.current++; pending.current = false; creation.current = null; setBusy(false); setError("");
    return () => { editorGeneration.current++; };
  }, [props.host.id]);
  const invoke = useSettingsInvoke(props.host.id);
  return <View style={{ padding: 20, width: 300, gap: 12 }}>
    <Text style={{ color: props.theme.colors.foreground, fontSize: 18 }}>Create teammate</Text>
    <TextInput accessibilityLabel="Teammate name" value={name} onChangeText={setName} editable={!busy} placeholder="Name"
      placeholderTextColor={props.theme.colors.foregroundMuted}
      style={{ color: props.theme.colors.foreground, borderColor: props.theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 10 }} />
    {error ? <Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger }}>{error}</Text> : null}
    <Pressable accessibilityRole="button" disabled={busy || !name.trim()} onPress={() => {
      if (pending.current || !name.trim()) return;
      pending.current = true;
      const requestGeneration = editorGeneration.current;
      const requestedName = name.trim();
      if (creation.current?.name !== requestedName) creation.current = {
        name: requestedName, operationId: `teammate:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      };
      setBusy(true); setError("");
      void invoke("profile.create", creation.current).then(result => {
        if (!result.ok) throw new Error(result.message);
        if (requestGeneration === editorGeneration.current) props.close();
      }).catch(error => { if (requestGeneration === editorGeneration.current) setError(error instanceof Error ? error.message : "Could not create teammate"); })
        .finally(() => { if (requestGeneration === editorGeneration.current) { pending.current = false; setBusy(false); } });
    }} style={{ paddingVertical: 10, opacity: busy || !name.trim() ? .5 : 1 }}>
      <Text style={{ color: props.theme.colors.foreground }}>{busy ? "Creating…" : "Create"}</Text>
    </Pressable>
  </View>;
}

export function Teammates(props: TeammatesProps) {
  const roster = useCompanions(props.host.id);
  const invoke = useSettingsInvoke(props.host.id);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [settings, setSettings] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const openingRef = useRef(false);
  const isSelected = (bot: CompanionProfile) => props.currentAgentId === undefined
    ? selected === bot.id
    : props.currentAgentId !== null && (bot.canonicalSessionId === props.currentAgentId
      || bot.sessions.some(session => session.id === props.currentAgentId));
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current++; openingRef.current = false; setOpening(null); setSettings(null); setSelected(null); setError("");
    return () => { generation.current++; openingRef.current = false; };
  }, [props.host.id]);
  useEffect(() => { if (roster.data) props.onProfiles(roster.data.profiles); }, [roster.data, props.onProfiles]);
  const navigate = (agentId: string) => {
    if (props.navigation) props.navigation.openAgent({ agentId, serverId: props.host.id });
    else props.openScreen({ screenId: "conversation", params: { agentId } });
  };
  const openChat = async (bot: CompanionProfile) => {
    if (openingRef.current) return;
    openingRef.current = true;
    const requestGeneration = generation.current;
    setOpening(bot.id); setError("");
    try {
      const result = await invoke("paseo.conversation.ensure", { botId: bot.id });
      if (requestGeneration !== generation.current) return;
      if (!result.ok) throw new Error(result.message);
      const value = result.value as { agentId: string };
      setSelected(bot.id); navigate(value.agentId);
    } catch (error) { if (requestGeneration === generation.current) setError(error instanceof Error ? error.message : "Could not open teammate"); }
    finally { if (requestGeneration === generation.current) { openingRef.current = false; setOpening(null); } }
  };
  const openMenu = (bot: CompanionProfile) => {
    const menuGeneration = generation.current;
    function Actions(menu: PluginPopoverProps) {
      return <View style={{ padding: 8, minWidth: 180 }}>
        {[
          { label: "Chat", run: () => { menu.close(); if (menuGeneration === generation.current) void openChat(bot); } },
          { label: "Settings", run: () => { menu.close(); if (menuGeneration === generation.current) setSettings(bot.id); } },
        ].map(action => <Pressable key={action.label} accessibilityRole="button" onPress={action.run} style={{ padding: 12 }}>
          <Text style={{ color: menu.theme.colors.foreground, fontSize: 14 }}>{action.label}</Text>
        </Pressable>)}
      </View>;
    }
    props.openPopover(Actions);
  };
  const context = (bot: CompanionProfile, children: ReactNode) => canRenderSettingsFrame
    ? <AvatarContext key={bot.id} onOpen={() => openMenu(bot)}>{children}</AvatarContext>
    : <View key={bot.id}>{children}</View>;
  return <View testID="cindy-teammates" style={{ paddingVertical: 4, gap: 2 }}>
    <Pressable onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={{ height: 24, paddingLeft: 24, paddingRight: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "Collapse teammates" : "Expand teammates"}
        accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20, fontWeight: "500" }}>Teammates</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Create teammate" onPress={() => props.openPopover(CreateTeammate)}
        style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", opacity: hovered || props.layout.compact ? 1 : 0 }}>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 18 }}>+</Text>
      </Pressable>
    </Pressable>
    {roster.isPending ? <ActivityIndicator size="small" color={props.theme.colors.foregroundMuted} style={{ alignSelf: "flex-start", marginLeft: 24, marginVertical: 8 }} /> : null}
    <View style={{ flexDirection: expanded ? "column" : "row", alignItems: expanded ? "stretch" : "center", paddingLeft: 18, paddingRight: 12, paddingVertical: 4, gap: expanded ? 4 : 0, flexWrap: "wrap" }}>
      {roster.data?.profiles.filter(bot => bot.status !== "archived").map(bot => context(bot,
        <View style={{ flexDirection: "row", alignItems: "center", flex: expanded ? 1 : undefined }}>
          <Pressable accessibilityRole="button" accessibilityLabel={bot.name} accessibilityHint="Open chat. Long press for settings."
            accessibilityState={{ selected: isSelected(bot), busy: opening === bot.id }}
            onPress={() => { void openChat(bot); }} onLongPress={() => openMenu(bot)} disabled={opening !== null}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: expanded ? 1 : undefined }}>
            <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: isSelected(bot) ? props.theme.colors.foreground : "transparent", opacity: opening === bot.id ? .5 : 1 }}>
              <Avatar bot={bot} appearance={appearanceFromBackground(props.theme.colors.surface0)} foreground={props.theme.colors.foreground} />
            </View>
            {expanded ? <Text numberOfLines={1} style={{ color: props.theme.colors.foreground, fontSize: 14, flex: 1 }}>{bot.name}</Text> : null}
          </Pressable>
          {expanded ? <Pressable accessibilityRole="button" accessibilityLabel={`${bot.name} settings`} onPress={() => setSettings(bot.id)} style={{ padding: 8 }}>
            <Text style={{ color: props.theme.colors.foregroundMuted }}>···</Text>
          </Pressable> : null}
        </View>,
      ))}
    </View>
    {error || roster.error ? <Pressable onPress={() => { setError(""); void roster.refetch(); }} style={{ paddingHorizontal: 20, paddingVertical: 6 }}>
      <Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger, fontSize: 12 }}>{error || roster.error?.message}</Text>
    </Pressable> : null}
    {settings ? <CompanionSettings key={`${props.host.id}:${settings}`} {...props} botId={settings} onClose={() => setSettings(null)}
      onNavigateAgent={agentId => { setSettings(null); navigate(agentId); }} /> : null}
  </View>;
}

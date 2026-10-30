import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import type { CompanionProfile } from "../shared/contracts";
import type { GroupMember, GroupSummary } from '../shared/groups';
import { avatarPresentation } from "./assets/avatar-presentation";
import { appearanceFromBackground } from "./frame-protocol";
import { useCompanions, useGroups, useSettingsInvoke } from "./data";
import { CompanionSettings } from "./settings";
import { AvatarContext, canRenderSettingsFrame } from "./web";

type SidebarNavigation = { openAgent(input: { agentId: string; serverId?: string }): void };
export interface TeammatesProps extends PluginSidebarItemProps {
  navigation?: SidebarNavigation;
  /** New hosts supply the focused native agent; older hosts keep click selection. */
  currentAgentId?: string | null;
  onProfiles(profiles: CompanionProfile[]): void;
}

function Avatar({ bot, appearance, foreground, size = 28 }: { bot: Pick<CompanionProfile, 'avatar' | 'avatarColor'>; appearance: "dark" | "light"; foreground: string; size?: number }) {
  const presentation = avatarPresentation(bot, appearance);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  useEffect(() => { setFailedUri(null); }, [presentation.uri]);
  const uri = presentation.uri !== failedUri ? presentation.uri : null;
  return <View style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden", backgroundColor: presentation.backgroundColor, justifyContent: "center", alignItems: "center" }}>
    {uri ? <Image accessibilityIgnoresInvertColors source={{ uri }} resizeMode="cover"
      onError={() => setFailedUri(uri)} style={{ width: size, height: size, borderRadius: size / 2 }} />
      : <Text style={{ fontSize: size * .64, color: foreground }}>{presentation.glyph}</Text>}
  </View>;
}

/** Same two-person overlap / first-five circular geometry as Cindy BotGroupSidebarAvatar. */
function GroupAvatar({ members, expanded, background, foreground, appearance }: { members: GroupMember[]; expanded: boolean; background: string; foreground: string; appearance: 'dark' | 'light' }) {
  const size = expanded ? 40 : 28;
  const visible = members.slice(0, 5).reverse();
  const diameter = visible.length === 3 ? .6 : visible.length === 4 ? .55 : .5;
  return <View style={{ width: size, height: size }}>
    {visible.map((member, index) => {
      const multiple = visible.length >= 3;
      const d = multiple ? diameter * size : visible.length === 1 ? size : expanded ? 24 : 18;
      const r = (size - d) / 2;
      const angle = -3 * Math.PI / 4 + index * 2 * Math.PI / visible.length;
      const left = multiple ? r * (1 + Math.cos(angle)) : index ? size - d : 0;
      const top = multiple ? r * (1 + Math.sin(angle)) : index ? size - d : 0;
      return <View key={member.botId} style={{ position: 'absolute', left, top, borderRadius: d, borderWidth: visible.length > 1 ? (expanded ? 2 : 1.5) : 0, borderColor: background }}>
        <Avatar bot={member} appearance={appearance} foreground={foreground} size={d} />
      </View>;
    })}
  </View>;
}

export function Teammates(props: TeammatesProps) {
  const roster = useCompanions(props.host.id);
  const groups = useGroups(props.host.id);
  const invoke = useSettingsInvoke(props.host.id);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [settings, setSettings] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'presets' | 'group-create' | 'teammate-create' | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const openingRef = useRef(false);
  const isSelected = (bot: CompanionProfile) => props.currentAgentId === undefined
    ? selected === bot.id
    : props.currentAgentId !== null && (bot.canonicalSessionId === props.currentAgentId
      || bot.sessions.some(session => session.id === props.currentAgentId));
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current++; openingRef.current = false; setOpening(null); setSettings(null); setDialog(null); setSelected(null); setError("");
    return () => { generation.current++; openingRef.current = false; };
  }, [props.host.id]);
  useEffect(() => { if (roster.data) props.onProfiles(roster.data.profiles); }, [roster.data, props.onProfiles]);
  const navigate = (agentId: string) => {
    if (props.navigation) props.navigation.openAgent({ agentId, serverId: props.host.id });
    else props.openScreen({ screenId: "conversation", params: { agentId } });
  };
  const navigateGroup = (groupId: string) => { setDialog(null); props.openScreen({ screenId: 'group', params: { groupId } }); };
  const openCreateMenu = () => {
    const menuGeneration = generation.current;
    function CreateActions(menu: PluginPopoverProps) {
      return <View style={{ padding: 8, minWidth: 220 }}>{[
        { label: 'Discover Teammates', run: () => setDialog('presets') },
        { label: 'New teammate', run: () => setDialog('teammate-create') },
        { label: 'New Group Chat', run: () => setDialog('group-create') },
      ].map(action => <Pressable key={action.label} accessibilityRole="button" onPress={() => {
        menu.close(); if (menuGeneration === generation.current) action.run();
      }} style={{ padding: 12 }}><Text style={{ color: menu.theme.colors.foreground, fontSize: 14 }}>{action.label}</Text></Pressable>)}</View>;
    }
    props.openPopover(CreateActions);
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
  const entries: Array<{ id: string; at: number; bot?: CompanionProfile; group?: GroupSummary }> = [
    ...(roster.data?.profiles.filter(bot => bot.status !== 'archived').map(bot => ({ id: bot.id, at: bot.lastMessageAt ?? bot.createdAt, bot })) ?? []),
    ...(groups.data?.map(group => ({ id: group.id, at: group.lastMessage?.createdAt ?? group.updatedAt, group })) ?? []),
  ].sort((a, b) => b.at - a.at);
  return <View testID="cindy-teammates" style={{ paddingVertical: 4, gap: 2 }}>
    <Pressable onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={{ height: 24, paddingLeft: 24, paddingRight: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "Collapse teammates" : "Expand teammates"}
        accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20, fontWeight: "500" }}>Teammates</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Create teammate" onPress={openCreateMenu}
        style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", opacity: hovered || props.layout.compact ? 1 : 0 }}>
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 18 }}>+</Text>
      </Pressable>
    </Pressable>
    {roster.isPending ? <ActivityIndicator size="small" color={props.theme.colors.foregroundMuted} style={{ alignSelf: "flex-start", marginLeft: 24, marginVertical: 8 }} /> : null}
    <View style={{ flexDirection: expanded ? "column" : "row", alignItems: expanded ? "stretch" : "center", paddingLeft: 18, paddingRight: 12, paddingVertical: 4, gap: expanded ? 4 : 0, flexWrap: "wrap" }}>
      {entries.map(entry => {
        if (entry.group) {
          const group = entry.group;
          const active = props.currentScreen?.screenId === 'group' && props.currentScreen.params.groupId === group.id;
          return <Pressable key={group.id} accessibilityRole="button" accessibilityLabel={group.name} accessibilityState={{ selected: active }}
            onPress={() => navigateGroup(group.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: expanded ? 8 : 2, borderRadius: 12 }}>
            <View style={{ borderWidth: 2, borderColor: active ? props.theme.colors.foreground : 'transparent', padding: 2, borderRadius: 24 }}>
              <GroupAvatar members={group.members} expanded={expanded} background={props.theme.colors.surface0} foreground={props.theme.colors.foreground} appearance={appearanceFromBackground(props.theme.colors.surface0)} />
            </View>
            {expanded ? <View style={{ flex: 1, gap: 3 }}><Text numberOfLines={1} style={{ color: props.theme.colors.foreground, fontSize: 14 }}>{group.name}</Text>
              <Text numberOfLines={1} style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>{group.round && ['running', 'queued', 'stopping'].includes(group.round.status) ? 'Discussing…' : group.lastMessage ? `${group.lastMessage.authorName}: ${group.lastMessage.content}` : 'Group chat'}</Text></View> : null}
          </Pressable>;
        }
        const bot = entry.bot!;
        return context(bot,
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
        );
      })}
    </View>
    {error || roster.error ? <Pressable onPress={() => { setError(""); void roster.refetch(); }} style={{ paddingHorizontal: 20, paddingVertical: 6 }}>
      <Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger, fontSize: 12 }}>{error || roster.error?.message}</Text>
    </Pressable> : null}
    {settings ? <CompanionSettings key={`${props.host.id}:${settings}`} {...props} botId={settings} onClose={() => setSettings(null)}
      onNavigateAgent={agentId => { setSettings(null); navigate(agentId); }} /> : null}
    {dialog ? <CompanionSettings key={`${props.host.id}:${dialog}`} {...props} botId="cindy" view={dialog} onClose={() => setDialog(null)}
      onNavigateAgent={agentId => { setDialog(null); navigate(agentId); }} onNavigateGroup={navigateGroup} /> : null}
  </View>;
}

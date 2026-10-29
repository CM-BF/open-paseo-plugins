import type { PluginButtonContentProps, PluginClientContext, PluginSidebarItemProps, PluginScreenProps } from "@getpaseo/plugin/client";
import type { CompanionProfile } from "./shared/contracts";
import { CompanionConversation } from "./client/conversation";
import { Teammates } from "./client/sidebar";
import { CompanionSettings } from "./client/settings";
import { CompanionGroup } from './client/group';
import { PresetOpening } from './client/opening';
import { OPENING_KIND, openingSchema } from './shared/opening';
import { contributeTaskCards } from './client/task-contribution';
import { contributeTaskOwner } from './client/task-owner';

export default function contribute(client: PluginClientContext) {
  const headers = new Map<string, { workspaceId: string; remove(): void }>();
  const synchronizeHeaders = (profiles: CompanionProfile[]) => {
    const live = new Set<string>();
    for (const profile of profiles) {
      const workspaceId = (profile as CompanionProfile & { canonicalWorkspaceId?: string }).canonicalWorkspaceId;
      if (!workspaceId || profile.status === "archived") continue;
      live.add(profile.id);
      if (headers.get(profile.id)?.workspaceId === workspaceId) continue;
      headers.get(profile.id)?.remove();
      function SettingsContent(props: PluginButtonContentProps) {
        return <CompanionSettings {...props} botId={profile.id} onClose={props.close}
          onNavigateAgent={agentId => { props.close(); client.openScreen({ screenId: "conversation", params: { agentId } }); }} />;
      }
      const registration = client.addHeaderButton({
        id: `teammate-settings-${profile.id}`, workspaceId,
        button: { title: "Settings", icon: "Settings", behavior: { kind: "popover", Content: SettingsContent } },
      });
      headers.set(profile.id, { workspaceId, remove: () => registration.remove() });
    }
    for (const [id, header] of headers) if (!live.has(id)) { header.remove(); headers.delete(id); }
  };
  function TeammatesItem(props: PluginSidebarItemProps) {
    return <Teammates {...props} onProfiles={synchronizeHeaders} />;
  }
  const removeSidebar = client.addSidebarHeaderItem({ id: "teammates", title: "Teammates", Component: TeammatesItem });
  const removeConversation = client.addScreen({ id: "conversation", title: "Teammate", Component: CompanionConversation });
  function GroupScreen(props: PluginScreenProps) {
    return <CompanionGroup {...props} onOpenGroup={groupId => client.openScreen({ screenId: 'group', params: { groupId } })} />;
  }
  const removeGroup = client.addScreen({ id: 'group', title: 'Group chat', Component: GroupScreen });
  const removeOpening = client.addTimelineRenderer({ kind: OPENING_KIND, version: 1, schema: openingSchema, Component: PresetOpening });
  const removeTaskCards = contributeTaskCards(client);
  const removeTaskOwner = contributeTaskOwner(client);
  const removeCommand = client.addCommandCenterItem({ id: "open-cindy", title: "Chat with Cindy", icon: "MessagesSquare", context: "global",
    onSelect({ openScreen }) { openScreen({ screenId: "conversation", params: { botId: "cindy" } }); },
  });
  return () => {
    removeSidebar(); removeConversation(); removeGroup(); removeOpening(); removeTaskCards(); removeTaskOwner(); removeCommand();
    for (const header of headers.values()) header.remove();
    headers.clear();
  };
}

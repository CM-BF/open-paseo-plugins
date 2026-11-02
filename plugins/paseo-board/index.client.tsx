import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BoardHome } from "./client/home";
import { installBoardEventTransport } from "./client/board-events";
import { boardChangedEvent, type BoardChange } from "./shared/contracts";

function Screen(props: PluginScreenProps) { return <BoardHome key={`${props.host.id}:${props.params.boardId ?? "all"}`} {...props} initialBoardId={props.params.boardId} />; }
function AgentPanel(props: PluginAgentPanelProps) { return <BoardHome key={`${props.host.id}:${props.workspaceId}:${props.params.agentId}`} {...props} agentId={props.params.agentId} />; }
function WorkspacePanel(props: PluginWorkspacePanelProps) { return <BoardHome key={`${props.host.id}:${props.workspaceId}`} {...props} />; }
function Sidebar(props: PluginSidebarItemProps) { return <SidebarRow label="Boards" icon="PanelsTopLeft" active={props.currentScreen?.screenId === "boards"} onPress={() => props.openScreen({ screenId: "boards" })} />; }

export default function contribute(client: PluginClientContext) {
  // Companion host API; keep old hosts readable while explicitly reporting unavailable live sync.
  const events = client as PluginClientContext & { subscribeEvent?: (contract: typeof boardChangedEvent, listener: { onEvent(event: BoardChange): void; onReconnect(): void; onError(error: Error): void }) => { ready: Promise<void>; dispose(): Promise<void> } };
  const removeEvents = typeof events.subscribeEvent === "function" ? installBoardEventTransport((_hostId, listener) => {
    try {
      const subscription = events.subscribeEvent!(boardChangedEvent, { onEvent: listener.change, onReconnect: listener.reconnect, onError: listener.error });
      void subscription.ready.catch(listener.error);
      return () => { void subscription.dispose().catch(listener.error); };
    } catch (error) { listener.error(error); return () => undefined; }
  }) : () => undefined;
  const removers = [removeEvents,
    client.addScreen({ id: "boards", title: "Boards", Component: Screen }),
    client.addSidebarHeaderItem({ id: "boards", title: "Boards", Component: Sidebar }),
    client.addAgentPanel({ id: "agent-board", title: "Boards", icon: "PanelsTopLeft", locations: ["workspace", "explorer"], Component: AgentPanel }),
    client.addWorkspacePanel({ id: "workspace-boards", title: "Boards", icon: "PanelsTopLeft", locations: ["workspace", "explorer"], Component: WorkspacePanel }),
    client.addCommandCenterItem({ id: "open-boards", title: "Open Boards", icon: "PanelsTopLeft", context: "global", keywords: ["board", "canvas", "decisions"], onSelect: context => context.openScreen({ screenId: "boards" }) }),
    client.addSlashCommand({ name: "board", description: "Open this workspace’s live Boards", argumentHint: "", context: "agent", onSubmit: context => context.openPanel("agent-board") }),
  ];
  return async () => { for (const remove of removers.reverse()) await remove(); };
}

import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BoardHome } from "./client/home";

function Screen(props: PluginScreenProps) { return <BoardHome key={`${props.host.id}:${props.params.boardId ?? "all"}`} {...props} initialBoardId={props.params.boardId} />; }
function AgentPanel(props: PluginAgentPanelProps) { return <BoardHome key={`${props.host.id}:${props.workspaceId}:${props.params.agentId}`} {...props} agentId={props.params.agentId} />; }
function WorkspacePanel(props: PluginWorkspacePanelProps) { return <BoardHome key={`${props.host.id}:${props.workspaceId}`} {...props} />; }
function Sidebar(props: PluginSidebarItemProps) { return <SidebarRow label="Boards" icon="PanelsTopLeft" active={props.currentScreen?.screenId === "boards"} onPress={() => props.openScreen({ screenId: "boards" })} />; }

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: "boards", title: "Boards", Component: Screen }),
    client.addSidebarHeaderItem({ id: "boards", title: "Boards", Component: Sidebar }),
    client.addAgentPanel({ id: "agent-board", title: "Boards", icon: "PanelsTopLeft", locations: ["workspace", "explorer"], Component: AgentPanel }),
    client.addWorkspacePanel({ id: "workspace-boards", title: "Boards", icon: "PanelsTopLeft", locations: ["workspace", "explorer"], Component: WorkspacePanel }),
    client.addCommandCenterItem({ id: "open-boards", title: "Open Boards", icon: "PanelsTopLeft", context: "global", keywords: ["board", "canvas", "decisions"], onSelect: context => context.openScreen({ screenId: "boards" }) }),
    client.addSlashCommand({ name: "board", description: "Open this workspace’s live Boards", argumentHint: "", context: "agent", onSubmit: context => context.openPanel("agent-board") }),
  ];
  return async () => { for (const remove of removers.reverse()) await remove(); };
}

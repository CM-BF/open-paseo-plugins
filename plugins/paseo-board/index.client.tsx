import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BoardHome } from "./client/home";
import { BoardInstallationProvider, createBoardInstallation } from "./client/transport";

function Screen(props: PluginScreenProps) { return <BoardHome {...props} initialBoardId={props.params.boardId} entryScope={{ hostId: props.host.id, surface: "screen" }} />; }
function AgentPanel(props: PluginAgentPanelProps) {
  const agentId = props.params?.agentId ?? props.agentId;
  return <BoardHome {...props} agentId={agentId} entryScope={{ hostId: props.host.id, surface: "agent", workspaceId: props.workspaceId, agentId }} />;
}
function WorkspacePanel(props: PluginWorkspacePanelProps) { return <BoardHome {...props} entryScope={{ hostId: props.host.id, surface: "workspace", workspaceId: props.workspaceId }} />; }
function Sidebar(props: PluginSidebarItemProps) { return <SidebarRow label="Boards" icon="PanelsTopLeft" active={props.currentScreen?.screenId === "boards"} onPress={() => props.openScreen({ screenId: "boards" })} />; }

export default function contribute(client: PluginClientContext) {
  const installation = createBoardInstallation(client);
  const removers = [
    client.addScreen({ id: "boards", title: "Boards", Component: props => <BoardInstallationProvider installation={installation} host={props.host}><Screen {...props} /></BoardInstallationProvider> }),
    client.addSidebarHeaderItem({ id: "boards", title: "Boards", Component: props => <BoardInstallationProvider installation={installation} host={props.host}><Sidebar {...props} /></BoardInstallationProvider> }),
    client.addAgentPanel({ id: "agent-board", title: "Boards", icon: "PanelsTopLeft", locations: ["workspace", "explorer"], Component: props => <BoardInstallationProvider installation={installation} host={props.host}><AgentPanel {...props} /></BoardInstallationProvider> }),
    client.addWorkspacePanel({ id: "workspace-boards", title: "Boards", icon: "PanelsTopLeft", locations: ["workspace", "explorer"], Component: props => <BoardInstallationProvider installation={installation} host={props.host}><WorkspacePanel {...props} /></BoardInstallationProvider> }),
    client.addCommandCenterItem({ id: "open-boards", title: "Open Boards", icon: "PanelsTopLeft", context: "global", keywords: ["board", "canvas", "decisions"], onSelect: context => context.openScreen({ screenId: "boards" }) }),
    client.addSlashCommand({ name: "board", description: "Open this workspace’s live Boards", argumentHint: "", context: "agent", onSubmit: context => context.openPanel("agent-board") }),
  ];
  return async () => { installation.dispose(); for (const remove of removers.reverse()) await remove(); };
}

import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { UPDATE_KIND, UPDATE_VERSION } from "./shared/constants";
import { learnRpc, rememberRpc, reviewRunRpc, updateRowSchema } from "./shared/contracts";
import { parseRemember } from "./shared/remember";
import { LearningScreen } from "./client/screen";
import { LearningSettings } from "./client/settings";
import { UpdateRowView } from "./client/update-row";

function LearningItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="BrainCircuit" active={currentScreen?.screenId === "main"} onPress={() => openScreen({ screenId: "main" })} />;
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: "main", title: "Learning", Component: (props) => <LearningScreen {...props} onOpenSettings={() => client.openSettings("preferences")} /> }),
    client.addSidebarHeaderItem({ id: "main", title: "Learning", Component: LearningItem }),
    client.addSettingsScreen({ id: "preferences", title: "Learning Loop", icon: "BrainCircuit", Component: LearningSettings }),
    client.addTimelineRenderer({ kind: UPDATE_KIND, version: UPDATE_VERSION, schema: updateRowSchema, Component: UpdateRowView }),
    client.addSlashCommand({
      name: "learn",
      description: "Turn a workflow, docs or a folder into a reusable skill (Hermes /learn)",
      argumentHint: "[what to learn: a path, a URL, or 'what we just did']",
      context: "agent",
      async onSubmit({ args, agent, rpc }) {
        const result = await rpc(learnRpc, { agentId: agent.id, request: args });
        if (!result.ok) throw new Error(result.message);
      },
    }),
    client.addSlashCommand({
      name: "remember",
      description: "Save a fact to shared memory without a turn (prefix user: or project:)",
      argumentHint: "[user:|project:] fact",
      context: "agent",
      async onSubmit({ args, agent, rpc }) {
        const { target, text } = parseRemember(args);
        if (!text) throw new Error("Write the fact after /remember, e.g. /remember project: tests run with npm test");
        const result = await rpc(rememberRpc, { text, target, cwd: agent.cwd, agentId: agent.id });
        if (!result.ok) throw new Error(result.message);
      },
    }),
    client.addSlashCommand({
      name: "review",
      description: "Review this conversation now and save lessons to memory and skills",
      argumentHint: "",
      context: "agent",
      async onSubmit({ agent, rpc }) {
        const result = await rpc(reviewRunRpc, { agentId: agent.id });
        if (!result.ok) throw new Error(result.message);
      },
    }),
    client.addCommandCenterItem({
      id: "open-learning",
      title: "Learning loop: memory, skills and past sessions",
      icon: "BrainCircuit",
      keywords: ["memory", "skills", "hermes", "session search", "learn"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "main" });
      },
    }),
    client.addCommandCenterItem({
      id: "learning-settings",
      title: "Learning loop settings",
      icon: "Settings",
      keywords: ["memory", "review", "curator", "hermes"],
      context: "global",
      onSelect({ openSettings }) {
        openSettings("preferences");
      },
    }),
    client.addCommandCenterItem({
      id: "search-sessions",
      title: "Search past sessions",
      icon: "Search",
      keywords: ["history", "recall", "session_search"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "main", params: { tab: "sessions" } });
      },
    }),
    client.addCommandCenterItem({
      id: "review-agent",
      title: "Learning loop: review this agent now",
      icon: "BrainCircuit",
      keywords: ["memory", "skills", "learn", "hermes"],
      context: "agent",
      async onSelect({ agent, rpc }) {
        const result = await rpc(reviewRunRpc, { agentId: agent.id });
        if (!result.ok) throw new Error(result.message);
      },
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}

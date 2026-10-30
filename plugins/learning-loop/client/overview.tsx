import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { View } from "react-native";
import { curatorRunRpc, overviewRpc, sessionsReindexRpc } from "../shared/contracts";
import { Badge, Body, Button, Card, ErrorText, Loading, Row, Title, UsageBar, when, type Themed } from "./kit";

export function OverviewTab({ theme, onOpen, onOpenSettings }: Themed & { onOpen(tab: "memory" | "skills" | "sessions" | "activity"): void; onOpenSettings(): void }) {
  const overview = useRpc(overviewRpc);
  const reindex = useRpc(sessionsReindexRpc);
  const curator = useRpc(curatorRunRpc);
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["overview"], queryFn: () => overview({}), refetchInterval: 15_000 });
  const action = useMutation({
    mutationFn: async (kind: "reindex" | "curate" | "consolidate") =>
      kind === "reindex" ? reindex({}) : curator({ consolidate: kind === "consolidate" }),
    onSuccess: (result) => {
      if (result.ok) toast.show(result.message, { variant: "success", durationMs: 4000 });
      else toast.error(result.message);
      void client.invalidateQueries();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  if (query.isPending) return <Loading theme={theme} />;
  if (query.isError) return <ErrorText theme={theme} error={query.error} />;
  const data = query.data;
  return (
    <View style={{ gap: 12 }}>
      <Card theme={theme}>
        <Row style={{ justifyContent: "space-between" }}>
          <Title theme={theme}>Memory</Title>
          {data.pending > 0 ? <Badge theme={theme} tone="warning" label={`${data.pending} waiting for approval`} /> : null}
        </Row>
        <Body theme={theme} muted>
          Injected into every new agent's system prompt. Agents write it with the memory tool; reviews add what they learn.
        </Body>
        {data.memory.map((store) => (
          <View key={store.label} style={{ gap: 4 }}>
            <Body theme={theme}>
              {store.label} · {store.entries} {store.entries === 1 ? "entry" : "entries"}
            </Body>
            <UsageBar theme={theme} used={store.used} limit={store.limit} />
          </View>
        ))}
        <Row>
          <Button theme={theme} icon="NotebookPen" label="Open memory" onPress={() => onOpen("memory")} />
        </Row>
      </Card>

      <Card theme={theme}>
        <Title theme={theme}>Skills</Title>
        <Body theme={theme} muted>
          Procedures agents write for classes of tasks, shared by every provider. Listed in new agents' prompts; loaded on demand with skill_view.
        </Body>
        <Row wrap>
          <Badge theme={theme} tone="success" label={`${data.skills.active} active`} />
          <Badge theme={theme} tone="warning" label={`${data.skills.stale} stale`} />
          <Badge theme={theme} label={`${data.skills.archived} archived`} />
        </Row>
        <Row wrap>
          <Button theme={theme} icon="BookOpen" label="Open skills" onPress={() => onOpen("skills")} />
          <Button theme={theme} icon="Archive" label="Run curator now" busy={action.isPending && action.variables === "curate"} onPress={() => action.mutate("curate")} />
          <Button theme={theme} icon="Combine" label="Consolidate with a model" busy={action.isPending && action.variables === "consolidate"} onPress={() => action.mutate("consolidate")} />
        </Row>
      </Card>

      <Card theme={theme}>
        <Title theme={theme}>Past sessions</Title>
        <Body theme={theme} muted>
          {data.sessions.sessions} sessions, {data.sessions.messages} messages indexed for session_search · last sync {when(data.sessions.lastSyncAt)}
        </Body>
        <Row wrap>
          <Button theme={theme} icon="Search" label="Search sessions" onPress={() => onOpen("sessions")} />
          <Button theme={theme} icon="RefreshCw" label="Index all agents" busy={action.isPending && action.variables === "reindex"} onPress={() => action.mutate("reindex")} />
        </Row>
      </Card>

      <Card theme={theme}>
        <Row style={{ justifyContent: "space-between" }}>
          <Title theme={theme}>Background review</Title>
          <Badge theme={theme} tone={data.route.ok ? "success" : "danger"} label={data.route.ok ? "model ready" : "model unavailable"} />
        </Row>
        <Body theme={theme} muted>
          After enough turns, a Claude Code review model reads a digest of the conversation and saves corrections and techniques as memory and skills.
        </Body>
        <Body theme={theme}>
          Model: {data.route.detail} · {data.reviews.total} reviews · last {when(data.reviews.lastAt)}
          {data.reviews.running ? ` · ${data.reviews.running} running` : ""}
        </Body>
        {data.budget ? <Body theme={theme}>UTC {data.budget.day}: ${data.budget.charged.toFixed(2)} charged + ${data.budget.reserved.toFixed(2)} reserved / ${data.budget.limit.toFixed(2)} host daily limit</Body> : null}
        {(data.reviews.queued ?? 0) > 0 ? <Body theme={theme}>{data.reviews.queued} queued or running</Body> : null}
        <Row wrap>
          <Button theme={theme} icon="Activity" label="Activity" onPress={() => onOpen("activity")} />
          <Button theme={theme} icon="Settings" label="Learning settings" onPress={onOpenSettings} />
        </Row>
      </Card>

      <Body theme={theme} muted selectable>
        {data.boundAgents} {data.boundAgents === 1 ? "agent has" : "agents have"} the learning tools · data in {data.stateDir}
      </Body>
    </View>
  );
}

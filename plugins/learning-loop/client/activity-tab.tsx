import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { reviewsListRpc, type ReviewRun } from "../shared/contracts";
import { Badge, Body, Card, Empty, ErrorText, Loading, Row, Title, when, type Themed } from "./kit";
import { LedgerList } from "./skills-tab";

const STATUS: Record<ReviewRun["status"], { label: string; tone: "default" | "accent" | "danger" | "success" | "warning" }> = {
  running: { label: "running", tone: "accent" },
  updated: { label: "saved", tone: "success" },
  staged: { label: "waiting for approval", tone: "warning" },
  nothing: { label: "nothing to save", tone: "default" },
  failed: { label: "failed", tone: "danger" },
};

function RunCard({ theme, run }: Themed & { run: ReviewRun }) {
  const status = STATUS[run.status];
  return (
    <Card theme={theme}>
      <Row wrap>
        <Title theme={theme}>{run.agentTitle ?? run.agentId}</Title>
        <Badge theme={theme} tone={status.tone} label={status.label} />
        <Badge theme={theme} label={run.trigger} />
      </Row>
      <Body theme={theme} muted>
        {when(run.startedAt)}
        {run.model ? ` · ${run.model}` : ""}
        {run.costUsd !== null ? ` · $${run.costUsd.toFixed(3)}` : ""}
      </Body>
      {run.actions.map((action, index) => (
        <Body key={index} theme={theme}>
          • {action}
        </Body>
      ))}
      {run.note ? (
        <Body theme={theme} muted selectable>
          {run.note}
        </Body>
      ) : null}
    </Card>
  );
}

export function ActivityTab({ theme }: Themed) {
  const list = useRpc(reviewsListRpc);
  const query = useQuery({ queryKey: ["reviews"], queryFn: () => list({ limit: 50 }), refetchInterval: 10_000 });
  return (
    <View style={{ gap: 12 }}>
      <Title theme={theme}>Reviews</Title>
      {query.isPending ? <Loading theme={theme} /> : query.isError ? <ErrorText theme={theme} error={query.error} /> : null}
      {query.data && query.data.runs.length === 0 ? <Empty theme={theme} icon="Activity" text="No reviews yet. They start after an agent has done enough work, or with /review in an agent's composer." /> : null}
      {query.data?.runs.map((run) => <RunCard key={run.id} theme={theme} run={run} />)}
      <Title theme={theme}>Skill changes</Title>
      <Card theme={theme}>
        <LedgerList theme={theme} skill={null} limit={30} />
      </Card>
    </View>
  );
}

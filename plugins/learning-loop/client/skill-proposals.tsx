import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { skillPendingRpc, skillPendingResolveRpc } from "../shared/contracts";
import { Badge, Body, Button, Card, ErrorText, Row, Title, type Themed } from "./kit";

export function SkillProposals({ theme }: Themed) {
  const list = useRpc(skillPendingRpc);
  const resolve = useRpc(skillPendingResolveRpc);
  const toast = useToast();
  const client = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["skill-proposals"], queryFn: () => list({}), refetchInterval: 5000 });
  const apply = useMutation({
    mutationFn: (input: { id: string; approve: boolean }) => resolve(input),
    onSuccess: result => { if (result.ok) toast.show(result.message, { variant: "success" }); else toast.error(result.message); void client.invalidateQueries(); },
    onError: error => toast.error(String(error)),
  });
  if (query.isError) return <ErrorText theme={theme} error={query.error} />;
  return <View style={{ gap: 8 }}>{query.data?.proposals.map(p => <Card key={p.id} theme={theme}>
    <Row wrap><Title theme={theme}>Skill proposal</Title><Badge theme={theme} label={p.actor.kind} /></Row>
    <Body theme={theme}>{p.summary}</Body>
    <Body theme={theme} muted>Approval checks the saved revisions again. Existing skill files stay unchanged until approval.</Body>
    <Row wrap>
      <Button theme={theme} label={expanded === p.id ? "Hide skill diff" : "Review skill diff"} onPress={() => setExpanded(expanded === p.id ? null : p.id)} />
      <Button theme={theme} label="Approve skill proposal" busy={apply.isPending} onPress={() => apply.mutate({ id: p.id, approve: true })} />
      <Button theme={theme} label="Reject skill proposal" tone="danger" busy={apply.isPending} onPress={() => apply.mutate({ id: p.id, approve: false })} />
    </Row>
    {expanded === p.id ? <View style={{ gap: 8 }}>{p.diff.length ? p.diff.map((d, i) => <View key={i} style={{ gap: 4 }}>
      <Body theme={theme}>{d.name}/{d.path}</Body><Body theme={theme} mono selectable>{`Before:\n${d.before ?? "(absent)"}\n\nAfter:\n${d.after ?? "(removed or archived)"}`}</Body>
    </View>) : <Body theme={theme}>State-only change: {p.summary}</Body>}</View> : null}
  </Card>)}</View>;
}

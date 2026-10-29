import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { ledgerListRpc, ledgerRollbackRpc, skillActionRpc, skillValidityRpc, skillsListRpc, skillViewRpc, type LedgerEntry, type SkillSummary } from "../shared/contracts";
import { SkillProposals } from "./skill-proposals";
import { Badge, Body, Button, Card, Empty, ErrorText, Loading, Row, Tabs, Title, when, type Themed } from "./kit";

type Filter = "all" | "active" | "stale" | "archived";

function useAction() {
  const act = useRpc(skillActionRpc);
  const toast = useToast();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; action: "pin" | "unpin" | "archive" | "restore" | "delete" | "reference" | "activate" }) => act(input),
    onSuccess: (result) => {
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
      void client.invalidateQueries();
    },
  });
}

export function LedgerList({ theme, skill, limit }: Themed & { skill: string | null; limit: number }) {
  const list = useRpc(ledgerListRpc);
  const rollback = useRpc(ledgerRollbackRpc);
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["ledger", skill, limit], queryFn: () => list({ skill, limit }) });
  const undo = useMutation({
    mutationFn: (id: string) => rollback({ id }),
    onSuccess: (result) => {
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
      void client.invalidateQueries();
    },
  });
  if (query.isPending) return <Loading theme={theme} />;
  if (query.isError) return <ErrorText theme={theme} error={query.error} />;
  if (query.data.entries.length === 0) return <Body theme={theme} muted>No changes recorded yet.</Body>;
  return (
    <View style={{ gap: 8 }}>
      {query.data.entries.map((entry: LedgerEntry) => (
        <View key={entry.id} style={{ flexDirection: "row", gap: 8, alignItems: "center", borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 6 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Body theme={theme}>
              {skill ? "" : `${entry.skill}: `}
              {entry.summary}
            </Body>
            <Body theme={theme} muted>
              {entry.actor.kind}
              {entry.actor.title ? ` (${entry.actor.title})` : ""} · {when(entry.at)}
              {entry.rolledBack ? " · rolled back" : ""}
            </Body>
          </View>
          {entry.action !== "rollback" && !entry.rolledBack ? (
            <Button theme={theme} icon="Undo2" label="Roll back" busy={undo.isPending && undo.variables === entry.id} onPress={() => undo.mutate(entry.id)} />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function SkillDetail({ theme, skill, compact }: Themed & { skill: SkillSummary; compact: boolean }) {
  const view = useRpc(skillViewRpc);
  const validity = useRpc(skillValidityRpc);
  const client = useQueryClient();
  const toast = useToast();
  const reviewLater = async () => {
    if (!skill.revision) return;
    const result = await validity({ name: skill.name, revision: skill.revision, validity: skill.validity === "reference" ? "reference" : "active", reviewDue: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    if (!result.ok) toast.error(result.message);
    void client.invalidateQueries();
  };
  const [file, setFile] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const action = useAction();
  const query = useQuery({ queryKey: ["skill", skill.name, file], queryFn: () => view({ name: skill.name, filePath: file }) });
  return (
    <View style={{ gap: 12 }}>
      <Body theme={theme} muted>{skill.source?.kind === "legacy" ? "Legacy · source unknown" : `Learned · ${skill.source?.agentId ?? "manual"}`} · {skill.validity ?? skill.state} · revision {skill.revision?.slice(0, 8) ?? "unknown"}</Body>
      {skill.reviewDue ? <Body theme={theme} muted>Review due: {when(skill.reviewDue)}. Due skills are omitted from new prompt indexes until renewed.</Body> : null}
      <Row wrap>
        <Button theme={theme} label="Review skill in 30 days" onPress={() => void reviewLater()} />
        <Button theme={theme} label={skill.validity === "reference" ? "Activate skill" : "Keep skill as reference"} onPress={() => action.mutate({ name: skill.name, action: skill.validity === "reference" ? "activate" : "reference" })} />
        {skill.state === "archived" ? (
          <Button theme={theme} icon="ArchiveRestore" label="Restore" onPress={() => action.mutate({ name: skill.name, action: "restore" })} />
        ) : (
          <Button theme={theme} icon="Archive" label="Archive" onPress={() => action.mutate({ name: skill.name, action: "archive" })} />
        )}
        <Button theme={theme} icon={skill.pinned ? "PinOff" : "Pin"} label={skill.pinned ? "Unpin" : "Pin"} onPress={() => action.mutate({ name: skill.name, action: skill.pinned ? "unpin" : "pin" })} />
        <Button theme={theme} icon="History" label={history ? "Hide history" : "History"} onPress={() => setHistory((v) => !v)} />
        <Button theme={theme} icon="Trash2" tone="danger" label="Delete" onPress={() => action.mutate({ name: skill.name, action: "delete" })} />
      </Row>
      {history ? <LedgerList theme={theme} skill={skill.name} limit={50} /> : null}
      {skill.files.length > 1 ? (
        <Row wrap>
          {skill.files.map((path) => (
            <Pressable key={path} onPress={() => setFile(path === "SKILL.md" ? null : path)}>
              <Badge theme={theme} tone={(file ?? "SKILL.md") === path ? "accent" : "default"} label={path} />
            </Pressable>
          ))}
        </Row>
      ) : null}
      {query.isPending ? <Loading theme={theme} /> : query.isError ? <ErrorText theme={theme} error={query.error} /> : (
        <View style={{ backgroundColor: theme.colors.surface0, borderRadius: 8, padding: compact ? 10 : 14, borderWidth: 1, borderColor: theme.colors.border }}>
          <Body theme={theme} mono selectable>
            {query.data.content}
          </Body>
        </View>
      )}
    </View>
  );
}

const SkillRow = memo(function SkillRow({ theme, skill, onOpen }: Themed & { skill: SkillSummary; onOpen(skill: SkillSummary): void }) {
  const tone = skill.state === "active" ? "success" : skill.state === "stale" ? "warning" : "default";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open skill ${skill.name}`} onPress={() => onOpen(skill)}>
      {({ pressed }) => (
        <Card theme={theme} style={pressed ? { backgroundColor: theme.colors.surface2 } : null}>
          <Row wrap>
            <Title theme={theme}>{skill.name}</Title>
            {skill.category ? <Badge theme={theme} label={skill.category} /> : null}
            <Badge theme={theme} tone={tone} label={skill.state} />
            {skill.pinned ? <Badge theme={theme} tone="accent" label="pinned" /> : null}
          </Row>
          <Body theme={theme}>{skill.description || "(no description)"}</Body>
          <Body theme={theme} muted>
            by {skill.createdBy} · used in {skill.useCount} {skill.useCount === 1 ? "session" : "sessions"} · {skill.patchCount} edits · last used {when(skill.lastUsedAt)}
            {skill.files.length > 1 ? ` · ${skill.files.length - 1} supporting files` : ""}
          </Body>
        </Card>
      )}
    </Pressable>
  );
});

export function SkillsTab({ theme, compact }: Themed & { compact: boolean }) {
  const list = useRpc(skillsListRpc);
  const query = useQuery({ queryKey: ["skills"], queryFn: () => list({ includeArchived: true }) });
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<SkillSummary | null>(null);
  const skills = useMemo(() => {
    const all = query.data?.skills ?? [];
    const needle = search.trim().toLowerCase();
    return all.filter((s) => (filter === "all" || s.state === filter) && (!needle || `${s.name} ${s.description} ${s.category ?? ""}`.toLowerCase().includes(needle)));
  }, [query.data, filter, search]);
  const counts = useMemo(() => {
    const all = query.data?.skills ?? [];
    return { stale: all.filter((s) => s.state === "stale").length };
  }, [query.data]);
  const current = open ? (query.data?.skills.find((s) => s.name === open.name) ?? open) : null;

  return (
    <View style={{ gap: 12 }}>
      <SkillProposals theme={theme} />
      <Tabs<Filter>
        theme={theme}
        value={filter}
        onChange={setFilter}
        tabs={[
          { id: "all", label: "All", icon: "Library" },
          { id: "active", label: "Active", icon: "CircleCheck" },
          { id: "stale", label: "Stale", icon: "Clock", badge: counts.stale },
          { id: "archived", label: "Archived", icon: "Archive" },
        ]}
      />
      <TextInput
        placeholder="Filter by name or description"
        placeholderTextColor={theme.colors.foregroundMuted}
        onChangeText={setSearch}
        style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 8, fontSize: 13.5 }}
      />
      {query.isPending ? <Loading theme={theme} /> : query.isError ? <ErrorText theme={theme} error={query.error} /> : null}
      {query.data && skills.length === 0 ? (
        <Empty theme={theme} icon="BookOpen" text={query.data.skills.length === 0 ? "No skills yet. Agents create them with skill_manage, reviews add them after work, and /learn turns docs or a workflow into one." : "No skill matches."} />
      ) : null}
      {skills.map((skill) => (
        <SkillRow key={skill.name} theme={theme} skill={skill} onOpen={setOpen} />
      ))}
      <Modal title={current ? current.name : "Skill"} open={current !== null} onOpenChange={(value) => (value ? null : setOpen(null))}>
        <Modal.Content>{current ? <SkillDetail theme={theme} skill={current} compact={compact} /> : null}</Modal.Content>
      </Modal>
    </View>
  );
}

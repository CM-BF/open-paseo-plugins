import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useRef, useState } from "react";
import { View } from "react-native";
import { memoryListRpc, memoryValidityRpc, memoryWriteRpc, pendingResolveRpc, type MemoryOp, type MemoryStoreView, type PendingWrite } from "../shared/contracts";
import { Badge, Body, Button, Card, Empty, ErrorText, Loading, Row, Title, UsageBar, when, type Themed } from "./kit";

function useWrite() {
  const write = useRpc(memoryWriteRpc);
  const toast = useToast();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { store: MemoryStoreView; operations: MemoryOp[] }) =>
      write({ target: input.store.target, projectKey: input.store.project?.key ?? null, operations: input.operations }),
    onSuccess: (result) => {
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
      void client.invalidateQueries();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
}

function Editor({ theme, initial, placeholder, onSave, onCancel, saveLabel }: Themed & { initial: string; placeholder: string; onSave(text: string): void; onCancel?(): void; saveLabel: string }) {
  const text = useRef(initial);
  const [key, setKey] = useState(0);
  return (
    <View style={{ gap: 6 }}>
      <TextInput
        key={key}
        defaultValue={initial}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline
        onChangeText={(value) => {
          text.current = value;
        }}
        style={{
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface0,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          padding: 8,
          minHeight: 40,
          fontSize: 13.5,
        }}
      />
      <Row>
        <Button
          theme={theme}
          primary
          label={saveLabel}
          onPress={() => {
            const value = text.current.trim();
            if (!value) return;
            onSave(value);
            if (!onCancel) {
              text.current = "";
              setKey((k) => k + 1);
            }
          }}
        />
        {onCancel ? <Button theme={theme} label="Cancel" onPress={onCancel} /> : null}
      </Row>
    </View>
  );
}

const Entry = memo(function Entry({ theme, store, entry }: Themed & { store: MemoryStoreView; entry: string }) {
  const [editing, setEditing] = useState(false);
  const validity = useRpc(memoryValidityRpc);
  const client = useQueryClient();
  const toast = useToast();
  const meta = store.metadata?.[store.entries.indexOf(entry)];
  const changeValidity = async (state: "active" | "reference" | "archived", reviewDue: string | null = null) => {
    if (!meta) return;
    const result = await validity({ target: store.target, projectKey: store.project?.key ?? null, id: meta.id, revision: meta.revision, state, reviewDue });
    if (!result.ok) toast.error(result.message);
    void client.invalidateQueries();
  };
  const write = useWrite();
  if (editing) {
    return (
      <Editor
        theme={theme}
        initial={entry}
        placeholder="Entry"
        saveLabel="Save"
        onCancel={() => setEditing(false)}
        onSave={(text) => {
          write.mutate({ store, operations: [{ action: "patch", old_text: entry, content: text }] });
          setEditing(false);
        }}
      />
    );
  }
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 8 }}>
      <View style={{ flex: 1 }}>
        <Body theme={theme} selectable>
          {entry}
        </Body>
        {meta ? <View style={{ gap: 6 }}>
          <Body theme={theme} muted>{meta.source === "legacy" ? "Legacy · source unknown" : `${meta.actor?.kind ?? "learned"} · ${meta.actor?.agentId ?? "manual"}`} · {meta.state} · revision {meta.revision.slice(0, 8)}{meta.reviewDue ? ` · review due ${when(meta.reviewDue)}` : ""}</Body>
          <Row wrap><Button theme={theme} label="Review memory in 30 days" onPress={() => void changeValidity(meta.state, new Date(Date.now() + 30 * 86_400_000).toISOString())} /><Button theme={theme} label={meta.state === "active" ? "Keep as reference" : "Activate memory"} onPress={() => void changeValidity(meta.state === "active" ? "reference" : "active")} />
          {meta.state !== "archived" ? <Button theme={theme} label="Archive memory" onPress={() => void changeValidity("archived")} /> : null}</Row>
        </View> : null}
      </View>
      <Button theme={theme} icon="Pencil" label="Edit" onPress={() => setEditing(true)} />
      <Button theme={theme} icon="Trash2" label="Delete" tone="danger" busy={write.isPending} onPress={() => write.mutate({ store, operations: [{ action: "remove", old_text: entry }] })} />
    </View>
  );
});

function StoreCard({ theme, store }: Themed & { store: MemoryStoreView }) {
  const write = useWrite();
  return (
    <Card theme={theme}>
      <Title theme={theme}>{store.label}</Title>
      {store.project ? (
        <Body theme={theme} muted selectable>
          {store.project.scope ?? "legacy project"}: {store.project.root}
        </Body>
      ) : null}
      <UsageBar theme={theme} used={store.used} limit={store.limit} />
      {store.entries.length === 0 ? <Body theme={theme} muted>No entries yet.</Body> : null}
      {store.entries.map((entry) => (
        <Entry key={entry} theme={theme} store={store} entry={entry} />
      ))}
      <Editor theme={theme} initial="" placeholder="Add an entry: one declarative fact" saveLabel="Add" onSave={(text) => write.mutate({ store, operations: [{ action: "add", content: text }] })} />
    </Card>
  );
}

function opText(op: MemoryOp): string {
  if (op.action === "add") return `add: ${op.content ?? ""}`;
  if (op.action === "remove") return `remove: ${op.old_text ?? ""}`;
  return `change "${op.old_text ?? ""}" → "${op.content ?? ""}"`;
}

function PendingCard({ theme, pending }: Themed & { pending: PendingWrite }) {
  const resolve = useRpc(pendingResolveRpc);
  const toast = useToast();
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (approve: boolean) => resolve({ id: pending.id, approve }),
    onSuccess: (result) => {
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
      void client.invalidateQueries();
    },
  });
  const who = pending.actor.kind === "review" ? "background review" : pending.actor.kind;
  const store = pending.target === "project" ? `project ${pending.project?.name ?? ""}` : pending.target;
  return (
    <Card theme={theme} style={{ borderColor: theme.colors.statusWarning }}>
      <Row wrap>
        <Badge theme={theme} tone="warning" label="waiting for approval" />
        <Body theme={theme} muted>
          {who} → {store} · {when(pending.createdAt)}
        </Body>
      </Row>
      {pending.operations.map((op, index) => (
        <Body key={index} theme={theme} selectable>
          {opText(op)}
        </Body>
      ))}
      <Row>
        <Button theme={theme} primary icon="Check" label="Approve" busy={mutation.isPending && mutation.variables === true} onPress={() => mutation.mutate(true)} />
        <Button theme={theme} icon="X" label="Reject" busy={mutation.isPending && mutation.variables === false} onPress={() => mutation.mutate(false)} />
      </Row>
    </Card>
  );
}

export function MemoryTab({ theme }: Themed) {
  const list = useRpc(memoryListRpc);
  const query = useQuery({ queryKey: ["memory"], queryFn: () => list({}) });
  if (query.isPending) return <Loading theme={theme} />;
  if (query.isError) return <ErrorText theme={theme} error={query.error} />;
  const { stores, pending } = query.data;
  return (
    <View style={{ gap: 12 }}>
      {pending.map((item) => (
        <PendingCard key={item.id} theme={theme} pending={item} />
      ))}
      <Body theme={theme} muted>
        Entries are separate facts. New agents get this as a snapshot when they start; a change here reaches the next agent you create. Project memory belongs to one repository and its worktrees.
      </Body>
      {stores.map((store) => (
        <StoreCard key={`${store.target}-${store.project?.key ?? ""}`} theme={theme} store={store} />
      ))}
      {stores.every((store) => store.target !== "project") ? <Empty theme={theme} icon="FolderGit2" text="No project memory yet. Agents create it when they save target='project' facts." /> : null}
    </View>
  );
}

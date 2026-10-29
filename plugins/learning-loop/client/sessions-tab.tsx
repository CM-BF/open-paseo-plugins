import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { sessionsClearRpc, sessionsReadRpc, sessionsSearchRpc, type SessionInfo, type SessionMessage } from "../shared/contracts";
import { Badge, Body, Button, Card, Empty, ErrorText, Loading, Row, Tabs, Title, when, type Themed } from "./kit";

type Sort = "relevance" | "newest" | "oldest";

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

function Message({ theme, message, highlight }: Themed & { message: SessionMessage; highlight: boolean }) {
  const label = message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "Tool";
  return (
    <View style={{ gap: 2, padding: 8, borderRadius: 8, backgroundColor: highlight ? theme.colors.surface2 : "transparent" }}>
      <Body theme={theme} muted>
        {label} · {when(message.at)}
      </Body>
      <Body theme={theme} selectable mono={message.role === "tool"}>
        {message.text}
      </Body>
    </View>
  );
}

function Reader({ theme, session, aroundSeq, navigation }: Themed & { session: SessionInfo; aroundSeq: number | null; navigation: PluginSurfaceProps["navigation"] }) {
  const read = useRpc(sessionsReadRpc);
  const query = useQuery({ queryKey: ["session", session.agentId, aroundSeq], queryFn: () => read({ agentId: session.agentId, aroundSeq, window: 40 }) });
  return (
    <View style={{ gap: 10 }}>
      <Row wrap>
        <Badge theme={theme} label={session.provider} />
        {session.archived ? <Badge theme={theme} label="archived" /> : null}
        <Body theme={theme} muted selectable>
          {session.cwd}
        </Body>
      </Row>
      {navigation && !session.archived ? (
        <Row>
          <Button theme={theme} icon="ExternalLink" label="Open agent" onPress={() => navigation.openAgent({ agentId: session.agentId })} />
        </Row>
      ) : null}
      {query.isPending ? <Loading theme={theme} /> : query.isError ? <ErrorText theme={theme} error={query.error} /> : (
        query.data.messages.map((message) => <Message key={message.seq} theme={theme} message={message} highlight={message.seq === aroundSeq} />)
      )}
    </View>
  );
}

export function SessionsTab({ theme, navigation }: Themed & { navigation: PluginSurfaceProps["navigation"] }) {
  const search = useRpc(sessionsSearchRpc);
  const clear = useRpc(sessionsClearRpc);
  const toast = useToast();
  const client = useQueryClient();
  const [scopePath, setScopePath] = useState("");
  const scope = useDebounced(scopePath, 500);
  const [text, setText] = useState("");
  const [sort, setSort] = useState<Sort>("relevance");
  const [open, setOpen] = useState<{ session: SessionInfo; seq: number | null } | null>(null);
  const query = useDebounced(text, 300);
  const result = useQuery({ queryKey: ["sessions", query, sort, scope], queryFn: () => search({ query, limit: 30, sort, scopePath: scope.trim() || null }) });

  return (
    <View style={{ gap: 12 }}>
      <TextInput
        placeholder='Search past conversations, e.g. "staging deploy" or 证书'
        placeholderTextColor={theme.colors.foregroundMuted}
        onChangeText={setText}
        style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14 }}
      />
      <TextInput placeholder="Repository/workspace path (blank searches this whole host)" placeholderTextColor={theme.colors.foregroundMuted} onChangeText={setScopePath} style={{ color: theme.colors.foreground, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 10 }} />
      <Body theme={theme} muted>{scope.trim() ? `Scope: ${scope.trim()}` : "Scope: all indexed projects on this host"}</Body>
      <Button theme={theme} label="Clear indexed copies" onPress={() => { void clear({}).then(result => { if (result.ok) toast.show(result.message); else toast.error(result.message); void client.invalidateQueries(); }); }} />
      <Tabs<Sort>
        theme={theme}
        value={sort}
        onChange={setSort}
        tabs={[
          { id: "relevance", label: "Best match", icon: "Sparkles" },
          { id: "newest", label: "Newest", icon: "ArrowDownWideNarrow" },
          { id: "oldest", label: "Oldest", icon: "ArrowUpNarrowWide" },
        ]}
      />
      {result.isPending ? <Loading theme={theme} /> : result.isError ? <ErrorText theme={theme} error={result.error} /> : null}
      {result.data && query.trim() && result.data.hits.length === 0 ? <Empty theme={theme} icon="SearchX" text="No past session matched." /> : null}
      {result.data?.hits.map((hit) => (
        <Pressable key={hit.session.agentId} accessibilityRole="button" onPress={() => setOpen({ session: hit.session, seq: hit.anchor.seq })}>
          <Card theme={theme}>
            <Row wrap>
              <Title theme={theme}>{hit.session.title ?? hit.session.agentId}</Title>
              <Badge theme={theme} label={hit.session.provider} />
              {hit.session.archived ? <Badge theme={theme} label="archived" /> : null}
            </Row>
            <Body theme={theme}>{hit.snippet}</Body>
            <Body theme={theme} muted>
              {hit.anchor.role} · {when(hit.anchor.at)} · {hit.session.messageCount} messages
            </Body>
          </Card>
        </Pressable>
      ))}
      {!query.trim() && result.data ? (
        result.data.recent.length === 0 ? (
          <Empty theme={theme} icon="MessagesSquare" text="Nothing indexed yet. Sessions are indexed after each turn and when the plugin starts." />
        ) : (
          <>
            <Body theme={theme} muted>
              Recent sessions
            </Body>
            {result.data.recent.map((session) => (
              <Pressable key={session.agentId} accessibilityRole="button" onPress={() => setOpen({ session, seq: null })}>
                <Card theme={theme}>
                  <Row wrap>
                    <Title theme={theme}>{session.title ?? session.agentId}</Title>
                    <Badge theme={theme} label={session.provider} />
                    {session.archived ? <Badge theme={theme} label="archived" /> : null}
                  </Row>
                  <Body theme={theme} muted>
                    {session.messageCount} messages · updated {when(session.updatedAt)}
                  </Body>
                </Card>
              </Pressable>
            ))}
          </>
        )
      ) : null}
      <Modal title={open?.session.title ?? "Session"} open={open !== null} onOpenChange={(value) => (value ? null : setOpen(null))}>
        <Modal.Content>{open ? <Reader theme={theme} session={open.session} aroundSeq={open.seq} navigation={navigation} /> : null}</Modal.Content>
      </Modal>
    </View>
  );
}

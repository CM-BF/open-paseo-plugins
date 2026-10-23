import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { SETTINGS_SCREEN, PLUGIN_ID } from "../shared/ids";
import { briefNowRpc, cancelFollowupRpc, checkNowRpc, pauseRpc, readFileRpc, updateAlertRpc, writeFileRpc } from "../shared/rpc";
import type { Activity, Alert, Overview, Planned, WaitingAgent } from "../shared/types";
import { ACTIVITY_ICON, errorMessage, outcomeTone, relative, STATE_LOOK, toneColor, urgencyTone, when } from "./format";
import { getClient } from "./client-ref";
import { useAction, useNow, useOverview } from "./queries";
import { SetupForm } from "./setup";
import { createStyles, type Styles } from "./styles";

type Theme = PluginScreenProps["theme"];

export function HomeScreen({ theme, layout, navigation }: PluginScreenProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const overview = useOverview();
  let body: ReactNode;
  if (overview.isPending) {
    body = (
      <View style={styles.row}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
        <Text style={styles.mutedText}>Loading…</Text>
      </View>
    );
  } else if (overview.isError) {
    body = (
      <View style={styles.section}>
        <Text style={styles.danger}>Aide did not answer: {errorMessage(overview.error)}</Text>
        <Pressable accessibilityRole="button" onPress={() => void overview.refetch()} style={[styles.button, { alignSelf: "flex-start" }]}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  } else if (overview.data.state === "not_set_up" || overview.data.state === "detached") {
    body = <SetupForm theme={theme} layout={layout} navigation={navigation} overview={overview.data} />;
  } else {
    body = <Dashboard data={overview.data} theme={theme} styles={styles} compact={layout.compact} navigation={navigation} />;
  }
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {body}
    </ScrollView>
  );
}

interface DashboardProps {
  data: Overview;
  theme: Theme;
  styles: Styles;
  compact: boolean;
  navigation: PluginScreenProps["navigation"];
}

function Dashboard({ data, theme, styles, compact, navigation }: DashboardProps) {
  const now = useNow();
  const toast = useToast();
  const checkNow = useAction(useRpc(checkNowRpc));
  const briefNow = useAction(useRpc(briefNowRpc));
  const pause = useAction(useRpc(pauseRpc));
  const look = STATE_LOOK[data.state];
  const agentId = data.assistant?.agentId ?? null;
  const open = data.alerts.filter((alert) => alert.status === "open" || alert.status === "snoozed");

  const run = async (action: () => Promise<{ message: string }>) => {
    try {
      toast.show((await action()).message, { variant: "success" });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <View style={{ gap: compact ? 16 : 20 }}>
      <View style={styles.section}>
        <View style={styles.between}>
          <View style={[styles.row, styles.grow]}>
            <Icon name="Sparkles" size={compact ? 20 : 24} color={theme.colors.accent} />
            <Text style={styles.heading} numberOfLines={1}>
              {data.config.name}
            </Text>
            <View style={[styles.pill, { borderColor: toneColor(theme, look.tone) }]}>
              <Text style={[styles.pillText, { color: toneColor(theme, look.tone) }]}>{look.label}</Text>
            </View>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Aide settings" hitSlop={8} onPress={() => getClient()?.openSettings(SETTINGS_SCREEN)}>
            <Icon name="Settings" size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        <Text style={styles.mutedText}>
          Today: {data.today.checkins} check-in{data.today.checkins === 1 ? "" : "s"}, {data.today.messages} proactive message{data.today.messages === 1 ? "" : "s"}
          {data.today.unanswered > 0 ? `, ${data.today.unanswered} unanswered` : ""} · {data.timezone}
        </Text>
        {data.busy ? (
          <View style={styles.row}>
            <ActivityIndicator size="small" color={theme.colors.accent} />
            <Text style={styles.mutedText}>Checking in the background since {relative(data.busy.since, now)}…</Text>
          </View>
        ) : null}
        <View style={styles.wrap}>
          {agentId && navigation ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Open the chat" onPress={() => navigation.openAgent({ agentId })} style={styles.primary}>
              <Text style={styles.primaryText}>Open chat</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Check in now" disabled={checkNow.isPending || Boolean(data.busy)} onPress={() => void run(() => checkNow.mutateAsync({}))} style={[styles.button, data.busy ? { opacity: 0.5 } : null]}>
            <Text style={styles.buttonText}>Check now</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Brief me now" disabled={briefNow.isPending} onPress={() => void run(() => briefNow.mutateAsync({}))} style={styles.button}>
            <Text style={styles.buttonText}>Brief me</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={data.state === "paused" ? "Resume" : "Pause"}
            disabled={pause.isPending}
            onPress={() => void run(() => pause.mutateAsync({ until: data.state === "paused" ? null : "always" }))}
            style={styles.button}
          >
            <Text style={styles.buttonText}>{data.state === "paused" ? "Resume" : "Pause"}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.grid}>
        <View style={styles.column}>
          <Section title={`Needs you${open.length > 0 ? ` (${open.length})` : ""}`} styles={styles}>
            {open.length === 0 ? <Text style={styles.empty}>Nothing right now. Background check-ins put things here when they need you.</Text> : open.map((alert, index) => <AlertRow key={alert.id} alert={alert} first={index === 0} theme={theme} styles={styles} now={now} timezone={data.timezone} />)}
          </Section>
          <Section title={`Waiting in Paseo${data.waiting.length > 0 ? ` (${data.waiting.length})` : ""}`} styles={styles}>
            {data.waiting.length === 0 ? <Text style={styles.empty}>No agents are waiting on you.</Text> : data.waiting.map((agent, index) => <WaitingRow key={agent.agentId} agent={agent} first={index === 0} theme={theme} styles={styles} now={now} navigation={navigation} />)}
          </Section>
        </View>
        <View style={styles.column}>
          <Section title="Planned" styles={styles}>
            {data.planned.length === 0 ? <Text style={styles.empty}>{data.state === "paused" ? "Paused. Reminders you asked for still fire." : "Nothing planned."}</Text> : data.planned.slice(0, 12).map((entry, index) => <PlannedRow key={`${entry.kind}-${entry.followupId ?? index}-${entry.at}`} entry={entry} first={index === 0} styles={styles} now={now} timezone={data.timezone} />)}
          </Section>
          <Section title="Activity" styles={styles}>
            {data.activity.length === 0 ? <Text style={styles.empty}>Nothing yet.</Text> : data.activity.slice(0, 25).map((entry, index) => <ActivityRow key={entry.id} entry={entry} first={index === 0} theme={theme} styles={styles} now={now} />)}
          </Section>
        </View>
      </View>

      <Files theme={theme} styles={styles} home={data.assistant?.home ?? ""} />
    </View>
  );
}

function Section({ title, styles, children }: { title: string; styles: Styles; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function AlertRow({ alert, first, theme, styles, now, timezone }: { alert: Alert; first: boolean; theme: Theme; styles: Styles; now: number; timezone: string }) {
  const update = useAction(useRpc(updateAlertRpc));
  const toast = useToast();
  const act = async (action: "done" | "snooze" | "mute" | "reopen", until?: string) => {
    try {
      toast.show((await update.mutateAsync({ id: alert.id, action, ...(until ? { until } : {}) })).message, { variant: "success" });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const snoozed = alert.status === "snoozed";
  return (
    <View>
      {first ? null : <View style={styles.divider} />}
      <View style={[styles.item, snoozed ? { opacity: 0.7 } : null]}>
        <View style={styles.between}>
          <View style={[styles.row, styles.grow]}>
            <View style={[styles.dot, { backgroundColor: toneColor(theme, urgencyTone(alert.urgency)) }]} />
            <Text style={styles.title} numberOfLines={2}>
              {alert.title}
            </Text>
          </View>
          <Text style={styles.muted}>{relative(alert.updatedAt, now)}</Text>
        </View>
        {alert.detail ? (
          <Text style={styles.mutedText} numberOfLines={4} selectable>
            {alert.detail}
          </Text>
        ) : null}
        <Text style={styles.muted}>
          {snoozed && alert.snoozedUntil ? `Snoozed until ${when(alert.snoozedUntil, timezone, now)}` : alert.delivered ? "Told you in the chat" : "Not sent yet (kept for later)"}
        </Text>
        <View style={[styles.wrap, { paddingTop: 4 }]}>
          {snoozed ? (
            <SmallButton label="Bring back" styles={styles} disabled={update.isPending} onPress={() => void act("reopen")} />
          ) : (
            <>
              <SmallButton label="Done" styles={styles} disabled={update.isPending} onPress={() => void act("done")} />
              <SmallButton label="In 3 h" styles={styles} disabled={update.isPending} onPress={() => void act("snooze", "in 3h")} />
              <SmallButton label="Tomorrow" styles={styles} disabled={update.isPending} onPress={() => void act("snooze", "tomorrow 9am")} />
              <SmallButton label="Don't remind me" styles={styles} disabled={update.isPending} onPress={() => void act("mute")} />
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function SmallButton({ label, styles, onPress, disabled }: { label: string; styles: Styles; onPress(): void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[styles.small, disabled ? { opacity: 0.5 } : null]}>
      <Text style={styles.smallText}>{label}</Text>
    </Pressable>
  );
}

const WAITING_LOOK: Record<WaitingAgent["reason"], { icon: string; label: string; tone: "warning" | "danger" | "muted" }> = {
  permission: { icon: "ShieldAlert", label: "needs approval", tone: "warning" },
  error: { icon: "TriangleAlert", label: "failed", tone: "danger" },
  finished: { icon: "CircleCheck", label: "finished", tone: "muted" },
};

function WaitingRow({ agent, first, theme, styles, now, navigation }: { agent: WaitingAgent; first: boolean; theme: Theme; styles: Styles; now: number; navigation: PluginScreenProps["navigation"] }) {
  const look = WAITING_LOOK[agent.reason];
  return (
    <View>
      {first ? null : <View style={styles.divider} />}
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${agent.title}`} disabled={!navigation} onPress={() => navigation?.openAgent({ agentId: agent.agentId })} style={styles.item}>
        <View style={styles.between}>
          <View style={[styles.row, styles.grow]}>
            <Icon name={look.icon} size={15} color={toneColor(theme, look.tone)} />
            <Text style={styles.title} numberOfLines={1}>
              {agent.title}
            </Text>
          </View>
          <Text style={styles.muted}>{agent.since ? relative(agent.since, now) : ""}</Text>
        </View>
        <Text style={styles.muted} numberOfLines={2}>
          {[agent.project, look.label, agent.detail].filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
    </View>
  );
}

const PLANNED_ICON: Record<Planned["kind"], string> = { checkin: "Radar", brief: "Sunrise", followup: "AlarmClock" };

function PlannedRow({ entry, first, styles, now, timezone }: { entry: Planned; first: boolean; styles: Styles; now: number; timezone: string }) {
  const cancel = useAction(useRpc(cancelFollowupRpc));
  const toast = useToast();
  return (
    <View>
      {first ? null : <View style={styles.divider} />}
      <View style={styles.item}>
        <View style={styles.between}>
          <View style={[styles.row, styles.grow]}>
            <Icon name={PLANNED_ICON[entry.kind]} size={15} color={styles.muted.color as string} />
            <Text style={styles.title} numberOfLines={1}>
              {entry.title}
            </Text>
          </View>
          {entry.followupId ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Cancel ${entry.title}`}
              hitSlop={8}
              disabled={cancel.isPending}
              onPress={() =>
                void cancel.mutateAsync({ id: entry.followupId! }).then(
                  () => toast.show("Canceled", { variant: "success" }),
                  (error) => toast.error(errorMessage(error)),
                )
              }
            >
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.muted}>
          {when(entry.at, timezone, now)}
          {entry.detail ? ` · ${entry.detail}` : ""}
        </Text>
      </View>
    </View>
  );
}

function ActivityRow({ entry, first, theme, styles, now }: { entry: Activity; first: boolean; theme: Theme; styles: Styles; now: number }) {
  const [open, setOpen] = useState(false);
  const tone = outcomeTone(entry.outcome);
  return (
    <View>
      {first ? null : <View style={styles.divider} />}
      <Pressable accessibilityRole="button" accessibilityLabel={entry.title} disabled={!entry.detail} onPress={() => setOpen((value) => !value)} style={styles.item}>
        <View style={styles.between}>
          <View style={[styles.row, styles.grow]}>
            <Icon name={ACTIVITY_ICON[entry.kind]} size={15} color={toneColor(theme, tone)} />
            <Text style={[styles.text, { flexShrink: 1 }]} numberOfLines={open ? undefined : 1}>
              {entry.title}
            </Text>
          </View>
          <Text style={styles.muted}>{relative(entry.at, now)}</Text>
        </View>
        {entry.detail ? (
          <Text style={styles.mutedText} numberOfLines={open ? undefined : 2} selectable={open}>
            {entry.detail}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

const FILES = [
  { name: "WATCHLIST.md" as const, label: "Watch list", hint: "What background check-ins look at. One line each: what, where, when to speak up." },
  { name: "MEMORY.md" as const, label: "Memory", hint: "What the assistant knows about you. It keeps this up to date; you can edit it too." },
];

function Files({ theme, styles, home }: { theme: Theme; styles: Styles; home: string }) {
  const [tab, setTab] = useState<(typeof FILES)[number]["name"]>("WATCHLIST.md");
  const file = FILES.find((entry) => entry.name === tab)!;
  const read = useRpc(readFileRpc);
  const write = useAction(useRpc(writeFileRpc));
  const toast = useToast();
  const query = useQuery({ queryKey: [PLUGIN_ID, "file", tab], queryFn: () => read({ name: tab }) });
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [tab]);
  const text = draft ?? query.data?.text ?? "";
  return (
    <View style={styles.section}>
      <View style={styles.between}>
        <View style={styles.row}>
          {FILES.map((entry) => (
            <Pressable key={entry.name} accessibilityRole="button" accessibilityLabel={entry.label} onPress={() => setTab(entry.name)} style={[styles.choice, entry.name === tab ? styles.choiceActive : null]}>
              <Text style={styles.choiceText}>{entry.label}</Text>
            </Pressable>
          ))}
        </View>
        {draft !== null ? (
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel="Discard changes" onPress={() => setDraft(null)} hitSlop={8}>
              <Text style={styles.link}>Discard</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Save ${file.label}`}
              disabled={write.isPending}
              onPress={() =>
                void write.mutateAsync({ name: tab, text: draft }).then(
                  () => {
                    setDraft(null);
                    toast.show(`${file.label} saved`, { variant: "success" });
                  },
                  (error) => toast.error(errorMessage(error)),
                )
              }
              style={styles.primary}
            >
              <Text style={styles.primaryText}>Save</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      <Text style={styles.muted}>
        {file.hint} {home ? `(${home}/${file.name})` : ""}
      </Text>
      {query.isError ? (
        <Text style={styles.danger}>{errorMessage(query.error)}</Text>
      ) : (
        <TextInput value={text} onChangeText={setDraft} multiline style={[styles.input, styles.textarea]} accessibilityLabel={file.label} placeholderTextColor={theme.colors.foregroundMuted} placeholder={query.isPending ? "Loading…" : ""} />
      )}
    </View>
  );
}

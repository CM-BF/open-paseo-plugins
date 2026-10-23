import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { PLUGIN_ID } from "../shared/ids";
import { modelsRpc, saveConfigRpc } from "../shared/rpc";
import { isClock, isValidTimeZone } from "../shared/time";
import { type Config, ConfigSchema } from "../shared/types";
import { errorMessage, INTERVALS, intervalLabel } from "./format";
import { useAction, useOverview } from "./queries";

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const overview = useOverview();
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  if (overview.isPending) return <Text style={muted}>Loading…</Text>;
  if (overview.isError) return <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>Aide did not answer: {errorMessage(overview.error)}</Text>;
  return <Editor key={JSON.stringify(overview.data.config)} config={overview.data.config} timezone={overview.data.timezone} chatAgent={overview.data.assistant?.agentId ?? null} theme={theme} />;
}

function Editor({ config, timezone, chatAgent, theme }: { config: Config; timezone: string; chatAgent: string | null; theme: PluginSurfaceProps["theme"] }) {
  const [draft, setDraft] = useState(config);
  const [numbers, setNumbers] = useState({ maxPerDay: String(config.checkins.maxPerDay), messagesPerDay: String(config.messagesPerDay), unansweredLimit: String(config.unansweredLimit) });
  const save = useAction(useRpc(saveConfigRpc));
  const listModels = useRpc(modelsRpc);
  const models = useQuery({ queryKey: [PLUGIN_ID, "models"], queryFn: () => listModels({}), staleTime: 5 * 60_000 });
  const toast = useToast();

  const errors = useMemo(() => {
    const found: Record<string, string> = {};
    if (!isClock(draft.brief.time)) found.brief = "Use HH:MM";
    if (!isClock(draft.activeHours.start)) found.start = "Use HH:MM";
    if (!isClock(draft.activeHours.end)) found.end = "Use HH:MM";
    if (draft.timezone && !isValidTimeZone(draft.timezone)) found.timezone = "Unknown time zone";
    for (const [key, value] of Object.entries(numbers)) if (!/^\d+$/.test(value.trim())) found[key] = "Use a whole number";
    return found;
  }, [draft, numbers]);

  const intervalOptions = INTERVALS.map((minutes) => ({ value: String(minutes), label: `Every ${intervalLabel(minutes)}` }));
  const checkinModels = models.data?.models ?? [{ value: draft.checkinModel, label: draft.checkinModel }];

  async function submit() {
    const parsed = ConfigSchema.safeParse({
      ...draft,
      checkins: { ...draft.checkins, maxPerDay: Number(numbers.maxPerDay) },
      messagesPerDay: Number(numbers.messagesPerDay),
      unansweredLimit: Number(numbers.unansweredLimit),
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return;
    }
    try {
      await save.mutateAsync({ config: parsed.data });
      toast.show("Saved", { variant: "success" });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <View style={{ gap: 20 }}>
      <SettingsSection title="Background check-ins">
        <SettingsCard>
          <SettingsSwitch label="Check in the background" hint="A read-only agent looks at your watch list and speaks up only when something needs you" value={draft.checkins.enabled} onValueChange={(enabled) => setDraft({ ...draft, checkins: { ...draft.checkins, enabled } })} />
          <SettingsSelect label="How often" hint="Stretches out by itself after several quiet checks" value={String(draft.checkins.everyMinutes)} options={intervalOptions} onValueChange={(value) => setDraft({ ...draft, checkins: { ...draft.checkins, everyMinutes: Number(value) } })} />
          <SettingsInput label="At most per day" error={errors.maxPerDay ?? null} initialValue={numbers.maxPerDay} onChangeText={(maxPerDay) => setNumbers({ ...numbers, maxPerDay })} />
          <SettingsSelect label="Model" hint="Applies from the next check-in" value={draft.checkinModel} options={checkinModels} onValueChange={(checkinModel) => setDraft({ ...draft, checkinModel })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Morning brief">
        <SettingsCard>
          <SettingsSwitch label="Send a morning brief" value={draft.brief.enabled} onValueChange={(enabled) => setDraft({ ...draft, brief: { ...draft.brief, enabled } })} />
          <SettingsInput label="Time" hint="HH:MM" error={errors.brief ?? null} initialValue={draft.brief.time} onChangeText={(time) => setDraft({ ...draft, brief: { ...draft.brief, time: time.trim() } })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="When it may reach out">
        <SettingsCard>
          <SettingsInput label="Active from" hint="Check-ins and proactive messages only inside these hours; reminders you asked for still fire" error={errors.start ?? null} initialValue={draft.activeHours.start} onChangeText={(start) => setDraft({ ...draft, activeHours: { ...draft.activeHours, start: start.trim() } })} />
          <SettingsInput label="Active until" error={errors.end ?? null} initialValue={draft.activeHours.end} onChangeText={(end) => setDraft({ ...draft, activeHours: { ...draft.activeHours, end: end.trim() } })} />
          <SettingsInput label="Proactive messages per day" hint="Urgent findings and things you asked for are not held back" error={errors.messagesPerDay ?? null} initialValue={numbers.messagesPerDay} onChangeText={(messagesPerDay) => setNumbers({ ...numbers, messagesPerDay })} />
          <SettingsInput label="Hold after unanswered messages" hint="0 never holds; held items wait in Needs you" error={errors.unansweredLimit ?? null} initialValue={numbers.unansweredLimit} onChangeText={(unansweredLimit) => setNumbers({ ...numbers, unansweredLimit })} />
          <SettingsInput label="Time zone" hint={`Empty uses this computer's (${timezone})`} error={errors.timezone ?? null} initialValue={draft.timezone} placeholder={timezone} onChangeText={(value) => setDraft({ ...draft, timezone: value.trim() })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Assistant">
        <SettingsCard>
          <SettingsInput label="Language" hint="For messages it starts; empty follows yours" initialValue={draft.language} onChangeText={(language) => setDraft({ ...draft, language })} />
          <SettingsRow label="Chat model" hint={`${config.chatModel}${chatAgent ? ". Change it in the chat's own model menu." : ""}`} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Save">
        <SettingsCard>
          <SettingsAction label="Save changes" hint={Object.keys(errors).length > 0 ? "Fix the fields marked above" : "Takes effect at once"} actionLabel={save.isPending ? "Saving…" : "Save"} disabled={save.isPending || Object.keys(errors).length > 0} onPress={() => void submit()} />
        </SettingsCard>
      </SettingsSection>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>The assistant can change these too when you ask it in the chat, for example “check every hour” or “pause until tomorrow morning”.</Text>
    </View>
  );
}

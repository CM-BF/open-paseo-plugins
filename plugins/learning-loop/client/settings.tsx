import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useRef } from "react";
import { Text, View } from "react-native";
import { preferences, type Preferences, type WriteApproval } from "../shared/settings";

type NumberKey = "userCharLimit" | "memoryCharLimit" | "projectCharLimit" | "skillsIndexLimit" | "sessionRetentionDays";
type ReviewNumberKey = "userTurns" | "toolCalls" | "cooldownMinutes" | "maxBudgetUsd" | "dailyBudgetUsd";

export function LearningSettings({ theme }: PluginSurfaceProps) {
  const state = useSettings(preferences);
  const draft = useRef<Record<string, string>>({});
  if (state.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>;
  if (state.status !== "ready") return <Text style={{ color: theme.colors.statusDanger }}>{state.status === "error" || state.status === "invalid" ? state.error : ""}</Text>;
  const values = state.values;
  const save = (next: Preferences) => void state.save(next, state.revision);
  const setReview = <K extends keyof Preferences["review"]>(key: K, value: Preferences["review"][K]) => save({ ...values, review: { ...values.review, [key]: value } });
  const setCurator = <K extends keyof Preferences["curator"]>(key: K, value: Preferences["curator"][K]) => save({ ...values, curator: { ...values.curator, [key]: value } });

  const number = (key: NumberKey, label: string, hint: string) => (
    <SettingsInput key={key} label={label} hint={hint} initialValue={String(values[key])} onChangeText={(text) => (draft.current[key] = text)} />
  );
  const reviewNumber = (key: ReviewNumberKey, label: string, hint: string) => (
    <SettingsInput key={key} label={label} hint={hint} initialValue={String(values.review[key])} onChangeText={(text) => (draft.current[`review.${key}`] = text)} />
  );
  const curatorNumber = (key: "staleAfterDays" | "archiveAfterDays", label: string) => (
    <SettingsInput key={key} label={label} initialValue={String(values.curator[key])} onChangeText={(text) => (draft.current[`curator.${key}`] = text)} />
  );
  const saveNumbers = () => {
    const next: Preferences = { ...values, review: { ...values.review }, curator: { ...values.curator } };
    for (const [key, text] of Object.entries(draft.current)) {
      if (key === "review.provider") {
        if (text.trim()) next.review.provider = text.trim();
        continue;
      }
      const value = Number(text);
      if (!Number.isFinite(value)) continue;
      if (key.startsWith("review.")) (next.review as Record<string, unknown>)[key.slice(7)] = value;
      else if (key.startsWith("curator.")) (next.curator as Record<string, unknown>)[key.slice(8)] = value;
      else (next as unknown as Record<string, unknown>)[key] = value;
    }
    draft.current = {};
    save(next);
  };

  return (
    <View style={{ gap: 8 }}>
      {state.saveError ? <Text style={{ color: theme.colors.statusDanger }}>{state.saveError}</Text> : null}
      <SettingsSection title="New agents">
        <SettingsCard>
          <SettingsSwitch label="Add memory and skills to the system prompt" hint="A snapshot of memory, the skills index and Hermes' guidance, added when an agent is created." value={values.injectPrompt} onValueChange={(v) => save({ ...values, injectPrompt: v })} />
          <SettingsSwitch label="Give agents the learning tools" hint="memory, skills_list, skill_view, skill_manage and session_search, for Claude Code, Codex and OpenCode." value={values.injectTools} onValueChange={(v) => save({ ...values, injectTools: v })} />
          <SettingsSwitch label="Preapprove the learning tools" hint="Agents use them without asking. Not applied to OpenCode." value={values.preapproveTools} onValueChange={(v) => save({ ...values, preapproveTools: v })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Memory">
        <SettingsCard>
          <SettingsSelect<WriteApproval>
            label="Approve writes"
            hint="Memory proposals wait in Memory; skill proposals wait in Skills. Human edits apply directly."
            value={values.writeApproval}
            options={[
              { label: "Never (write freely)", value: "off" },
              { label: "Background reviews only", value: "background" },
              { label: "Every agent write", value: "all" },
            ]}
            onValueChange={(v) => save({ ...values, writeApproval: v })}
          />
          {number("userCharLimit", "User profile limit (chars)", "Hermes default 1375")}
          {number("memoryCharLimit", "Memory limit (chars)", "Hermes default 2200")}
          {number("projectCharLimit", "Project memory limit (chars)", "Per repository")}
          {number("skillsIndexLimit", "Skills listed in the prompt", "Most recently used first; 0 hides the index")}
          <SettingsSwitch label="Index sessions for session_search" hint="Reads saved Claude and Codex conversations into local SQLite without starting agents." value={values.indexSessions} onValueChange={(v) => save({ ...values, indexSessions: v })} />
          {number("sessionRetentionDays", "Keep indexed messages (days)", "0 keeps all; deletes only index copies, never source sessions")}
          <SettingsSwitch label="Publish Learned catalog" hint="Optional read-only skill content for Skills Center. Disabling removes the export within 15 seconds." value={values.exportCatalog} onValueChange={(v) => save({ ...values, exportCatalog: v })} />
          <SettingsAction label="Numbers above" actionLabel="Save" onPress={saveNumbers} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Background review">
        <SettingsCard>
          <SettingsSwitch label="Review agents after they work" value={values.review.enabled} onValueChange={(v) => setReview("enabled", v)} />
          <Text style={{ color: theme.colors.foregroundMuted }}>Background reviews currently require Claude Code. Learning tools can be used by other supported providers.</Text>
          <SettingsInput label="Claude-family provider" hint="A Paseo provider id that runs Claude Code, e.g. claude" initialValue={values.review.provider} onChangeText={(text) => (draft.current["review.provider"] = text)} />
          <SettingsSelect
            label="Model"
            value={["haiku", "sonnet", "opus"].includes(values.review.model) ? values.review.model : "sonnet"}
            options={[
              { label: "Haiku (cheapest)", value: "haiku" },
              { label: "Sonnet", value: "sonnet" },
              { label: "Opus", value: "opus" },
            ]}
            onValueChange={(v) => setReview("model", v)}
          />
          {reviewNumber("userTurns", "After this many user turns", "Hermes memory nudge interval")}
          {reviewNumber("toolCalls", "Or after this many tool calls", "Hermes skill nudge interval")}
          {reviewNumber("cooldownMinutes", "Minutes between reviews of one agent", "")}
          {reviewNumber("dailyBudgetUsd", "Host budget per UTC day (USD)", "All reviews and curator share this limit; 0 prevents model runs. Pending runs reserve their maximum before launch.")}
          {reviewNumber("maxBudgetUsd", "Budget per review (USD)", "The run stops at this list-price estimate")}
          <SettingsSwitch label="Review subagents and helper agents" value={values.review.includeChildAgents} onValueChange={(v) => setReview("includeChildAgents", v)} />
          <SettingsSwitch label="Review leftover work when an agent is archived" value={values.review.onArchive} onValueChange={(v) => setReview("onArchive", v)} />
          <SettingsAction label="Provider and numbers above" actionLabel="Save" onPress={saveNumbers} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Curator">
        <SettingsCard>
          <SettingsSwitch label="Retire unused agent-written skills" hint="Pinned skills and skills you wrote are never touched. Archived skills can be restored." value={values.curator.enabled} onValueChange={(v) => setCurator("enabled", v)} />
          {curatorNumber("staleAfterDays", "Mark stale after (days unused)")}
          {curatorNumber("archiveAfterDays", "Archive after (days unused)")}
          <SettingsAction label="Days above" actionLabel="Save" onPress={saveNumbers} />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

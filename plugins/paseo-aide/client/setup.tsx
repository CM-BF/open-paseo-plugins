import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsInput, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { DEFAULT_WATCHLIST } from "../shared/defaults";
import { PLUGIN_ID } from "../shared/ids";
import { type ModelCatalog, modelsRpc, setupRpc } from "../shared/rpc";
import type { Overview } from "../shared/types";
import { errorMessage } from "./format";
import { useAction } from "./queries";
import { createStyles } from "./styles";

const PREFERRED_CHAT = ["claude/claude-sonnet-5-5", "claude/claude-opus-5-5", "codex/gpt-6.1-sol"];
const PREFERRED_CHECKIN = ["claude/claude-haiku-4-5", "codex/gpt-6-luna", "claude/claude-sonnet-5-5"];

function pick(options: readonly { value: string }[], preferred: readonly string[], fallback: string): string {
  return preferred.find((value) => options.some((option) => option.value === value)) ?? options[0]?.value ?? fallback;
}

/** First run, or setting up again after the chat was archived (the folder and its files are kept). */
export function SetupForm({ theme, layout, navigation, overview }: Pick<PluginScreenProps, "theme" | "layout" | "navigation"> & { overview: Overview }) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const listModels = useRpc(modelsRpc);
  const models = useQuery({ queryKey: [PLUGIN_ID, "models"], queryFn: () => listModels({}), staleTime: 5 * 60_000 });
  if (models.isPending) {
    return (
      <View style={[styles.row, { padding: 12 }]}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
        <Text style={styles.mutedText}>Looking up the models on this host…</Text>
      </View>
    );
  }
  if (models.isError) return <Text style={styles.danger}>Could not list models: {errorMessage(models.error)}</Text>;
  return <SetupFields theme={theme} layout={layout} navigation={navigation} overview={overview} catalog={models.data} />;
}

function SetupFields({
  theme,
  layout,
  navigation,
  overview,
  catalog,
}: Pick<PluginScreenProps, "theme" | "layout" | "navigation"> & { overview: Overview; catalog: ModelCatalog }) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const toast = useToast();
  const setup = useAction(useRpc(setupRpc));
  const previous = overview.assistant;
  const [name, setName] = useState(overview.config.name);
  const [language, setLanguage] = useState(overview.config.language);
  const [home, setHome] = useState(previous?.home ?? catalog.defaultHome);
  const [chatModel, setChatModel] = useState(() => (catalog.models.some((model) => model.value === overview.config.chatModel) ? overview.config.chatModel : pick(catalog.models, PREFERRED_CHAT, overview.config.chatModel)));
  const [checkinModel, setCheckinModel] = useState(() => (catalog.models.some((model) => model.value === overview.config.checkinModel) ? overview.config.checkinModel : pick(catalog.models, PREFERRED_CHECKIN, overview.config.checkinModel)));
  const provider = chatModel.split("/")[0] ?? "";
  const modes = catalog.modes[provider] ?? [];
  const [chatMode, setChatMode] = useState(overview.config.chatMode);
  const mode = modes.some((entry) => entry.value === chatMode) ? chatMode : (modes.find((entry) => entry.value === "auto")?.value ?? modes[0]?.value ?? "");
  const [watchlist, setWatchlist] = useState(DEFAULT_WATCHLIST);

  async function submit() {
    try {
      const result = await setup.mutateAsync({ name: name.trim() || "Aide", language, home, chatModel, chatMode: mode, checkinModel, ...(previous ? {} : { watchlist }) });
      toast.show(`${name.trim() || "Aide"} is set up`, { variant: "success" });
      navigation?.openAgent({ agentId: result.agentId });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <View style={{ gap: 18 }}>
      <View style={styles.section}>
        <Text style={styles.heading}>{previous ? "Set up again" : "Meet your personal agent"}</Text>
        <Text style={styles.mutedText}>
          {previous
            ? "The chat was archived, so proactive work stopped. A new chat starts with the same folder, memory and watch list."
            : "An always-on agent on this computer: a brief every morning, quiet background check-ins that only speak up when something needs you, and follow-ups it schedules for itself. You chat with it like any Paseo agent, on desktop or phone."}
        </Text>
      </View>
      <SettingsSection title="Assistant">
        <SettingsCard>
          <SettingsInput label="Name" hint="Its chat's title" initialValue={name} onChangeText={setName} placeholder="Aide" />
          <SettingsInput label="Language" hint="For messages it starts; empty follows yours" initialValue={language} onChangeText={setLanguage} placeholder="e.g. 中文 or English" />
          <SettingsInput label="Folder" hint="Its working folder, with MEMORY.md and WATCHLIST.md" initialValue={home} onChangeText={setHome} placeholder={catalog.defaultHome} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Models">
        <SettingsCard>
          <SettingsSelect label="Chat" hint="Writes to you and does the work" value={chatModel} options={catalog.models} onValueChange={setChatModel} />
          {modes.length > 0 ? <SettingsSelect label="Permissions" hint="Approval mode of the chat" value={mode} options={modes} onValueChange={setChatMode} /> : null}
          <SettingsSelect label="Background check-ins" hint="Read-only; a cheaper model is plenty" value={checkinModel} options={catalog.models} onValueChange={setCheckinModel} />
        </SettingsCard>
      </SettingsSection>
      {previous ? null : (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What should it keep an eye on?</Text>
          <Text style={styles.muted}>One line each: what, where, and when to speak up. You and the assistant can change it any time.</Text>
          <TextInput
            value={watchlist}
            onChangeText={setWatchlist}
            multiline
            style={[styles.input, styles.textarea]}
            accessibilityLabel="Watch list"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
        </View>
      )}
      <Text style={styles.muted}>
        Defaults: brief at {overview.config.brief.time}, check-ins every {overview.config.checkins.everyMinutes} min between {overview.config.activeHours.start} and {overview.config.activeHours.end} ({catalog.timezone}). Change them later in the settings.
      </Text>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Set up the personal agent" disabled={setup.isPending || catalog.models.length === 0} onPress={() => void submit()} style={[styles.primary, setup.isPending ? { opacity: 0.6 } : null]}>
          <Text style={styles.primaryText}>{setup.isPending ? "Setting up…" : previous ? "Set up again" : `Set up ${name.trim() || "Aide"}`}</Text>
        </Pressable>
        {catalog.models.length === 0 ? <Text style={styles.danger}>No Claude, Codex or OpenCode models are available on this host.</Text> : null}
      </View>
    </View>
  );
}

import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  applyConfigRpc,
  checkRpc,
  clearKeyRpc,
  FALLBACK_OPTIONS,
  LANGUAGE_OPTIONS,
  type LastRequest,
  type LastSpeech,
  macVoicesRpc,
  MODE_OPTIONS,
  MODEL_OPTIONS,
  revertConfigRpc,
  sampleRpc,
  saveKeyRpc,
  speechPreviewRpc,
  statusRpc,
  TTS_ENGINE_OPTIONS,
  TTS_MODEL_OPTIONS,
  TTS_VOICE_OPTIONS,
  type VoiceSettings,
  type VoiceStatus,
  voiceSettings,
} from "../shared/contracts";

const STATUS_KEY = ["paseo-gemini-voice", "status"] as const;
const AI_STUDIO_KEYS = "https://aistudio.google.com/apikey";
const PRICING = "https://ai.google.dev/gemini-api/docs/pricing";

const STATE_LABELS: Readonly<Record<VoiceStatus["dictation"]["state"], string>> = {
  active: "已改用 Gemini",
  "pending-restart": "等待重启 Daemon",
  "not-applied": "未接入",
  foreign: "正在用其他接口",
  overridden: "被覆盖",
  error: "读取配置出错",
};

function errorMessage(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  return error instanceof Error ? error.message : String(error);
}

function describeLast(last: LastRequest): string {
  const time = new Date(last.at).toLocaleTimeString();
  const source = last.source === "sample" ? "示例音频" : "听写";
  if (!last.ok) return `${time} ${source}失败`;
  const model = last.model ? ` · ${last.model}${last.fallbackUsed ? "（备用）" : ""}` : "";
  return `${time} ${source} · ${last.audioSeconds} 秒音频 · 用时 ${(last.latencyMs / 1000).toFixed(1)} 秒${model}`;
}

function describeSpeech(last: LastSpeech): string {
  const time = new Date(last.at).toLocaleTimeString();
  const source = last.source === "preview" ? "试听" : "语音对话";
  if (!last.ok) return `${time} ${source}朗读失败`;
  const engine = last.engine === "macos" ? `macOS ${last.voice ?? ""}` : `${last.model ?? "Gemini"} · ${last.voice ?? ""}`;
  return `${time} ${source} · ${last.chars} 字 · ${last.audioSeconds} 秒音频 · 用时 ${(last.latencyMs / 1000).toFixed(1)} 秒 · ${engine}${last.fallbackUsed ? "（Gemini 出错，已改用 macOS）" : ""}`;
}

function parseVocabulary(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.split(/[\n,，、;；]+/)) {
    const term = raw.trim().slice(0, 120);
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
  }
  return terms.slice(0, 1000);
}

function withCurrent<Value extends string>(
  options: readonly { label: string; value: Value }[],
  current: string,
): { label: string; value: string }[] {
  const list: { label: string; value: string }[] = options.map((option) => ({ label: option.label, value: option.value }));
  if (!list.some((option) => option.value === current)) list.push({ label: current, value: current });
  return list;
}

export interface VoiceSettingsScreenProps extends PluginSurfaceProps {
  playAudio(source: { base64: string; mimeType: string }): Promise<void>;
}

export function VoiceSettingsScreen({ theme, layout, playAudio }: VoiceSettingsScreenProps) {
  const readStatus = useRpc(statusRpc);
  const saveKeyCall = useRpc(saveKeyRpc);
  const clearKeyCall = useRpc(clearKeyRpc);
  const checkCall = useRpc(checkRpc);
  const sampleCall = useRpc(sampleRpc);
  const previewCall = useRpc(speechPreviewRpc);
  const macVoicesCall = useRpc(macVoicesRpc);
  const applyCall = useRpc(applyConfigRpc);
  const revertCall = useRpc(revertConfigRpc);
  const queryClient = useQueryClient();
  const settings = useSettings(voiceSettings);

  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => readStatus({}),
    refetchInterval: 5_000,
    retry: 1,
  });
  const refreshStatus = () => queryClient.invalidateQueries({ queryKey: STATUS_KEY });

  const keyInput = useRef<SettingsInputHandle>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const saveKey = useMutation({
    mutationFn: (apiKey: string) => saveKeyCall({ apiKey }),
    onSuccess: async () => {
      keyInput.current?.replaceText("");
      setKeyDraft("");
      await refreshStatus();
    },
  });
  const clearKey = useMutation({ mutationFn: () => clearKeyCall({}), onSuccess: refreshStatus });
  const check = useMutation({ mutationFn: () => checkCall({}) });
  const sample = useMutation({ mutationFn: () => sampleCall({}), onSettled: refreshStatus });
  const macVoices = useQuery({
    queryKey: ["paseo-gemini-voice", "mac-voices"],
    queryFn: () => macVoicesCall({}),
    staleTime: Infinity,
  });
  const [playError, setPlayError] = useState<string | null>(null);
  const preview = useMutation({
    mutationFn: () => previewCall({}),
    onSuccess: async (result) => {
      setPlayError(null);
      await refreshStatus();
      if (!result.ok || !result.audio) return;
      try {
        await playAudio({ base64: result.audio, mimeType: "audio/wav" });
      } catch (error) {
        setPlayError(errorMessage(error) ?? "播放失败");
      }
    },
  });
  const updateStatus = (next: VoiceStatus) => queryClient.setQueryData(STATUS_KEY, next);
  const apply = useMutation({ mutationFn: () => applyCall({}), onSuccess: updateStatus });
  const revert = useMutation({ mutationFn: () => revertCall({}), onSuccess: updateStatus });

  const values = settings.status === "ready" ? settings.values : null;
  const revision = settings.status === "ready" ? settings.revision : null;
  const [vocabularyDraft, setVocabularyDraft] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);
  useEffect(() => {
    // A save from another client replaces the stored list; drop a draft that matches it.
    if (values && vocabularyDraft !== null && parseVocabulary(vocabularyDraft).join("\n") === values.vocabulary.join("\n")) {
      setVocabularyDraft(null);
    }
  }, [values, vocabularyDraft]);

  const saveSettings = (patch: Partial<VoiceSettings>) => {
    if (!values || !revision) return;
    void settings.save({ ...values, ...patch }, revision);
  };

  const data = status.data;
  const dictation = data?.dictation;
  const busy = apply.isPending || revert.isPending;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 } as const;
  const body = { color: theme.colors.foreground, fontSize: 13 } as const;
  const portNumber = portDraft === null ? null : Number.parseInt(portDraft, 10);
  const portValid = portNumber !== null && Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;

  return (
    <View style={{ gap: layout.compact ? 16 : 24 }}>
      <SettingsSection title="状态">
        <SettingsCard>
          <SettingsRow
            label={`听写和语音对话：${dictation ? STATE_LABELS[dictation.state] : "读取中…"}`}
            hint={dictation?.detail}
            error={errorMessage(status.error)}
          />
          <SettingsRow
            label="本地转发"
            hint={
              data
                ? data.proxy.listening
                  ? `正在 ${data.proxy.url} 处理 Paseo 的听写、语音识别和朗读请求`
                  : (data.proxy.error ?? "未启动")
                : undefined
            }
            error={data && !data.proxy.listening ? data.proxy.error : null}
          />
          {data?.last ? (
            <SettingsRow label="最近一次识别" hint={describeLast(data.last)} error={data.last.error}>
              {data.last.textPreview ? (
                <Text selectable style={[body, { paddingVertical: 6 }]}>
                  {data.last.textPreview}
                </Text>
              ) : null}
            </SettingsRow>
          ) : null}
          {data?.lastSpeech ? (
            <SettingsRow label="最近一次朗读" hint={describeSpeech(data.lastSpeech)} error={data.lastSpeech.error} />
          ) : null}
          {data && data.counters.requests > 0 ? (
            <SettingsRow
              label="本次运行"
              hint={`识别 ${data.counters.requests} 次，失败 ${data.counters.failures} 次，共约 ${data.counters.audioSeconds} 秒音频`}
            />
          ) : null}
          <SettingsAction
            label="刷新状态"
            actionLabel={status.isFetching ? "刷新中…" : "刷新"}
            disabled={status.isFetching}
            onPress={() => void status.refetch()}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Gemini API key">
        <SettingsCard>
          {data?.apiKey.configured ? (
            <SettingsRow
              label="已保存"
              hint={`${data.apiKey.hint ?? ""}${data.apiKey.source === "env" ? "，来自 Daemon 的环境变量" : "，只保存在运行 Paseo 的这台电脑上"}`}
            />
          ) : null}
          <SettingsInput
            ref={keyInput}
            label={data?.apiKey.configured ? "换一个 key" : "粘贴 API key"}
            placeholder="AIza… 或 AQ.…"
            secureTextEntry
            onChangeText={setKeyDraft}
            disabled={saveKey.isPending}
          />
          <SettingsAction
            label="保存并测试"
            hint={saveKey.data ? `已保存 ${saveKey.data.hint}。${saveKey.data.check.message}` : undefined}
            error={errorMessage(saveKey.error) ?? (saveKey.data && !saveKey.data.check.ok ? "测试没有通过，见上面的说明。" : null)}
            actionLabel={saveKey.isPending ? "保存中…" : "保存"}
            disabled={keyDraft.trim().length < 10 || saveKey.isPending}
            onPress={() => saveKey.mutate(keyDraft.trim())}
          />
          <SettingsAction
            label="测试连接"
            hint={check.data?.ok ? check.data.message : "确认 key 能用所选模型，不发送音频。"}
            error={errorMessage(check.error) ?? (check.data && !check.data.ok ? check.data.message : null)}
            actionLabel={check.isPending ? "测试中…" : "测试"}
            disabled={!data?.apiKey.configured || check.isPending}
            onPress={() => check.mutate()}
          />
          <SettingsAction
            label="用示例音频试一下"
            hint={
              sample.data?.ok
                ? `识别结果：${sample.data.text || "（空）"}\n原句：${sample.data.expected}\n用时 ${(sample.data.latencyMs / 1000).toFixed(1)} 秒 · ${sample.data.model ?? ""}`
                : "发送一段内置的中英混说录音到 Gemini，不用重启就能看到识别效果。"
            }
            error={errorMessage(sample.error) ?? (sample.data && !sample.data.ok ? sample.data.error : null)}
            actionLabel={sample.isPending ? "识别中…" : "试一下"}
            disabled={!data?.apiKey.configured || sample.isPending}
            onPress={() => sample.mutate()}
          />
          {data?.apiKey.source === "plugin" ? (
            <SettingsAction
              label="删除已保存的 key"
              actionLabel={clearKey.isPending ? "删除中…" : "删除"}
              disabled={clearKey.isPending}
              error={errorMessage(clearKey.error)}
              onPress={() => clearKey.mutate()}
            />
          ) : null}
          <SettingsRow label="怎么拿到 key">
            <View style={{ gap: 6, paddingVertical: 6 }}>
              <ExternalLink href={AI_STUDIO_KEYS}>在 Google AI Studio 创建 API key</ExternalLink>
              <Text style={muted}>
                不绑卡也能用免费额度，但 Google 可能用免费层的请求改进产品。给 AI Studio 项目绑定结算账号后不会被这样使用，额度也更高。
              </Text>
              <Text style={muted}>
                Google AI Pro 订阅每月附带 10 美元 Google Cloud 额度，在 Google Developer Program 里领取后可以抵扣 Gemini API 费用。gemini-3.5-transcribe 官方价格约每分钟 0.005 美元。
              </Text>
              <ExternalLink href={PRICING}>查看 Gemini API 价格</ExternalLink>
            </View>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="接入 Paseo">
        <SettingsCard>
          <SettingsRow
            label="怎么生效"
            hint="写入时会改 Paseo 的 config.json（先自动备份），只改听写和语音对话的语音设置。重启一次 Daemon 后，输入框里的麦克风和语音对话都能说中文。手机上也能重启：设置 → 主机 → 重启 Daemon，正在运行的 Agent 会继续运行。"
          />
          {dictation?.canApply ? (
            <SettingsAction
              label="让听写和语音对话改用 Gemini"
              hint={data?.apiKey.configured ? undefined : "先在上面保存 Gemini API key。"}
              actionLabel={apply.isPending ? "写入中…" : "写入配置"}
              disabled={busy || !data?.apiKey.configured}
              error={errorMessage(apply.error)}
              onPress={() => apply.mutate()}
            />
          ) : null}
          {dictation?.canRevert ? (
            <SettingsAction
              label="恢复原来的听写设置"
              hint="停用或删除本插件前先恢复，否则听写会因为连不上本地转发而失败。恢复后同样要重启 Daemon。"
              actionLabel={revert.isPending ? "恢复中…" : "恢复"}
              disabled={busy}
              error={errorMessage(revert.error)}
              onPress={() => revert.mutate()}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      {values ? (
        <SettingsSection title="语音对话的朗读">
          <SettingsCard>
            <SettingsRow
              label="说明"
              hint="语音对话里你说的话由 Gemini 识别，Agent 的回复用下面的引擎读出来。Gemini 出错或额度用完时，自动改用 macOS 本地朗读。"
            />
            <SettingsSelect
              label="朗读引擎"
              value={values.ttsEngine}
              options={macVoices.data && macVoices.data.voices.length === 0 ? TTS_ENGINE_OPTIONS.filter((option) => option.value === "gemini") : TTS_ENGINE_OPTIONS}
              disabled={settings.saving}
              onValueChange={(ttsEngine) => saveSettings({ ttsEngine })}
            />
            {values.ttsEngine === "gemini" ? (
              <SettingsSelect
                label="Gemini 朗读模型"
                value={values.ttsModel}
                options={withCurrent(TTS_MODEL_OPTIONS, values.ttsModel)}
                disabled={settings.saving}
                onValueChange={(ttsModel) => saveSettings({ ttsModel })}
              />
            ) : null}
            {values.ttsEngine === "gemini" ? (
              <SettingsSelect
                label="Gemini 音色"
                value={values.ttsVoice}
                options={withCurrent(TTS_VOICE_OPTIONS, values.ttsVoice)}
                disabled={settings.saving}
                onValueChange={(ttsVoice) => saveSettings({ ttsVoice })}
              />
            ) : null}
            {macVoices.data && macVoices.data.voices.length > 0 ? (
              <SettingsSelect
                label={values.ttsEngine === "macos" ? "macOS 音色" : "macOS 兜底音色"}
                value={values.macVoice}
                options={withCurrent(
                  macVoices.data.voices
                    .filter((voice) => voice.locale.startsWith("zh"))
                    .map((voice) => ({ label: `${voice.name}（${voice.locale}）`, value: voice.name })),
                  values.macVoice,
                )}
                disabled={settings.saving}
                onValueChange={(macVoice) => saveSettings({ macVoice })}
              />
            ) : null}
            <SettingsAction
              label="试听"
              hint={
                preview.data?.ok
                  ? `${preview.data.engine === "macos" ? `macOS ${preview.data.voice ?? ""}` : `${preview.data.model ?? ""} · ${preview.data.voice ?? ""}`}，合成用时 ${(preview.data.latencyMs / 1000).toFixed(1)} 秒${preview.data.fallbackUsed ? "（Gemini 出错，已改用 macOS）" : ""}`
                  : "用当前设置读一句中英混合的话，在这台设备上播放。"
              }
              error={errorMessage(preview.error) ?? (preview.data && !preview.data.ok ? preview.data.error : null) ?? playError}
              actionLabel={preview.isPending ? "合成中…" : "试听"}
              disabled={preview.isPending}
              onPress={() => preview.mutate()}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <SettingsSection title="识别设置">
        {values ? (
          <SettingsCard>
            <SettingsSelect
              label="模型"
              hint="gemini-3.5-transcribe 是专用语音识别模型，支持一句话里中英混说和专有词。"
              value={values.model}
              options={withCurrent(MODEL_OPTIONS, values.model)}
              disabled={settings.saving}
              onValueChange={(model) => saveSettings({ model })}
            />
            <SettingsSelect
              label="备用模型"
              hint="主模型不可用、超时或额度用完时改用它。"
              value={values.fallbackModel}
              options={withCurrent(FALLBACK_OPTIONS, values.fallbackModel)}
              disabled={settings.saving}
              onValueChange={(fallbackModel) => saveSettings({ fallbackModel })}
            />
            <SettingsSelect
              label="整理方式"
              value={values.mode}
              options={MODE_OPTIONS}
              disabled={settings.saving}
              onValueChange={(mode) => saveSettings({ mode })}
            />
            <SettingsSelect
              label="语言"
              hint="自动识别能处理一句话里中英文混着说。"
              value={values.languages}
              options={LANGUAGE_OPTIONS}
              disabled={settings.saving}
              onValueChange={(languages) => saveSettings({ languages })}
            />
            <SettingsRow
              label="专有词"
              hint="每行一个。帮助识别产品名、人名和代码术语，建议不超过 100 个。"
              error={settings.saveError}
            />
            {/* A card row of its own: SettingsRow content does not span the card width. */}
            <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
              <TextInput
                multiline
                value={vocabularyDraft ?? values.vocabulary.join("\n")}
                onChangeText={setVocabularyDraft}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Paseo"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  minHeight: 120,
                  maxHeight: 260,
                  padding: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                  color: theme.colors.foreground,
                  fontSize: 13,
                  textAlignVertical: "top",
                }}
              />
            </View>
            <SettingsAction
              label={`保存专有词${vocabularyDraft === null ? `（${values.vocabulary.length} 个）` : ""}`}
              actionLabel={settings.saving ? "保存中…" : "保存"}
              disabled={vocabularyDraft === null || settings.saving}
              onPress={() => {
                if (vocabularyDraft !== null) saveSettings({ vocabulary: parseVocabulary(vocabularyDraft) });
              }}
            />
          </SettingsCard>
        ) : (
          <SettingsCard>
            <SettingsRow
              label={settings.status === "loading" ? "读取中…" : "设置无法读取"}
              error={settings.status === "error" || settings.status === "invalid" ? settings.error : null}
            />
          </SettingsCard>
        )}
      </SettingsSection>

      {values ? (
        <SettingsSection title="高级">
          <SettingsCard>
            <SettingsInput
              label="本地转发端口"
              hint="只监听 127.0.0.1。改端口后需要重新写入配置并重启 Daemon。"
              initialValue={String(values.port)}
              onChangeText={setPortDraft}
              error={portDraft !== null && !portValid ? "端口要在 1024 到 65535 之间。" : null}
            />
            <SettingsAction
              label="保存端口"
              actionLabel="保存"
              disabled={!portValid || portNumber === values.port || settings.saving}
              onPress={() => {
                if (portValid && portNumber !== null) saveSettings({ port: portNumber });
              }}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </View>
  );
}

import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { catalogRpc, configureRpc } from "../shared/rpc";
import { ConfigSchema, PLUGIN_ID, type Config } from "../shared/types";
import { Button, ErrorText, Field, type Styles, useOverviewAction } from "./ui";

function positiveInteger(text: string, label: string, min: number, max: number) {
  if (!/^\d+$/.test(text.trim())) throw new Error(`${label}需要填写整数。`);
  const value = Number(text);
  if (value < min || value > max) throw new Error(`${label}应在 ${min} 到 ${max} 之间。`);
  return value;
}

export function SettingsForm({ config, styles, onSaved, onCancel }: {
  config: Config; styles: Styles; onSaved(): void; onCancel(): void;
}) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [repos, setRepos] = useState(config.repos.join("\n"));
  const [pollSeconds, setPollSeconds] = useState(String(config.pollSeconds));
  const [backfillDays, setBackfillDays] = useState(String(config.backfillDays));
  const [timeout, setTimeout] = useState(String(config.workerTimeoutSeconds));
  const [worker, setWorker] = useState(config.worker);
  const [features, setFeatures] = useState(JSON.stringify(config.worker.featureValues, null, 2));
  const [error, setError] = useState<unknown>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [showModels, setShowModels] = useState(false);
  const catalog = useRpc(catalogRpc);
  const options = useQuery({ queryKey: [PLUGIN_ID, "catalog"], queryFn: () => catalog({}), staleTime: 60_000 });
  const save = useOverviewAction(useRpc(configureRpc));
  const provider = options.data?.providers.find((entry) => entry.id === worker.provider);
  const model = provider?.models.find((entry) => entry.id === worker.model);
  const models = provider?.models.filter((entry) => `${entry.id} ${entry.label}`.toLowerCase().includes(modelSearch.toLowerCase())) ?? [];
  const disabled = save.isPending;

  const submit = async () => {
    setError(null);
    try {
      let featureValues: unknown;
      try { featureValues = JSON.parse(features); } catch { throw new Error("模型功能需要有效的 JSON 对象。"); }
      if (!featureValues || Array.isArray(featureValues) || typeof featureValues !== "object" || Object.values(featureValues).some((value) => !["string", "number", "boolean"].includes(typeof value))) {
        throw new Error("模型功能需要 JSON 对象，值只能是字符串、数字或布尔值。");
      }
      const next = ConfigSchema.safeParse({
        ...config,
        enabled,
        repos: [...new Set(repos.split(/\r?\n/).map((repo) => repo.trim()).filter(Boolean))],
        pollSeconds: positiveInteger(pollSeconds, "扫描间隔", 60, 86400),
        backfillDays: positiveInteger(backfillDays, "历史回溯天数", 0, 365),
        workerTimeoutSeconds: positiveInteger(timeout, "分析超时", 60, 7200),
        worker: { ...worker, featureValues },
      });
      if (!next.success) throw new Error(next.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
      await save.mutateAsync({ config: next.data });
      onSaved();
    } catch (cause) { setError(cause); }
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.sectionTitle}>监听与分析设置</Text>
      <Text style={styles.muted}>保存时使用 daemon 的现有 gh 登录验证本人身份。仓库白名单最多 10 个；GitHub 数据仅用于只读分析。</Text>
      <View style={styles.wrap}>
        <Button label={enabled ? "自动监听：开启" : "自动监听：暂停"} selected={enabled} styles={styles} disabled={disabled} onPress={() => setEnabled((value) => !value)} />
      </View>
      <Field label="仓库白名单" hint="每行一个 owner/repository。仅接收绑定本人 numeric ID 创建的 issue。" value={repos} onChange={setRepos} multiline styles={styles} disabled={disabled} placeholder="owner/repository" />
      <View style={styles.grid}>
        <View style={styles.column}>
          <Field label="扫描间隔（秒）" hint="60–86400 秒；空扫描不调用模型。" value={pollSeconds} onChange={setPollSeconds} numeric styles={styles} disabled={disabled} />
        </View>
        <View style={styles.column}>
          <Field label="历史回溯天数" hint="0–365 天。0 不自动派发历史 issue；已发现条目仍可手动开始 triage。" value={backfillDays} onChange={setBackfillDays} numeric styles={styles} disabled={disabled} />
        </View>
      </View>
      <View style={styles.divider} />
      <Text style={styles.label}>分析 worker</Text>
      <Text style={styles.muted}>可用选项来自当前 daemon。模型只给出分类、优先级和建议，不修改仓库或 GitHub。</Text>
      {options.isPending ? <Text style={styles.muted}>正在读取 provider 能力…</Text> : null}
      <ErrorText error={options.error} styles={styles} />
      {options.isError ? <View style={styles.wrap}><Button label="重新读取能力" styles={styles} disabled={options.isFetching} onPress={() => void options.refetch()} /></View> : null}
      <Field label="Provider ID" value={worker.provider} onChange={(providerId) => setWorker((current) => ({ ...current, provider: providerId }))} styles={styles} disabled={disabled} maxLength={80} />
      <View style={styles.wrap}>
        {options.data?.providers.map((entry) => <Button key={entry.id} label={entry.id} selected={entry.id === worker.provider} styles={styles} disabled={disabled}
          onPress={() => { setWorker((current) => ({ ...current, provider: entry.id })); setModelSearch(""); }} />)}
      </View>
      <Field label="Model ID" value={worker.model} onChange={(modelId) => setWorker((current) => ({ ...current, model: modelId }))} styles={styles} disabled={disabled} maxLength={120} />
      <View style={styles.wrap}><Button label={showModels ? "收起可用模型" : `选择可用模型 (${provider?.models.length ?? 0})`} styles={styles} disabled={disabled || !provider} onPress={() => setShowModels((value) => !value)} /></View>
      {showModels && provider ? <View style={styles.section}>
        <Field label="筛选模型" value={modelSearch} onChange={setModelSearch} styles={styles} disabled={disabled} placeholder="按模型名称或 ID 筛选" />
        <ScrollView style={styles.choices} contentContainerStyle={styles.choiceContent} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {models.map((entry) => <Button key={entry.id} label={`${entry.label} (${entry.id})`} selected={entry.id === worker.model} styles={styles} disabled={disabled}
            onPress={() => { setWorker((current) => ({ ...current, model: entry.id, thinkingOptionId: entry.thinking.includes(current.thinkingOptionId) ? current.thinkingOptionId : entry.thinking[0] ?? "" })); setShowModels(false); }} />)}
          {models.length === 0 ? <Text style={styles.muted}>没有匹配的模型。</Text> : null}
        </ScrollView>
      </View> : null}
      {provider && !model ? <Text style={styles.warning}>当前 Model ID 未出现在该 provider 的模型列表中，启用监听前需要通过能力校验。</Text> : null}
      <Field label="权限模式 ID" value={worker.modeId} onChange={(modeId) => setWorker((current) => ({ ...current, modeId }))} styles={styles} disabled={disabled} maxLength={80} />
      <View style={styles.wrap}>
        {provider?.modes.map((mode) => <Button key={mode.id} label={`${mode.label} (${mode.id})`} selected={mode.id === worker.modeId} styles={styles} disabled={disabled}
          onPress={() => setWorker((current) => ({ ...current, modeId: mode.id }))} />)}
      </View>
      <Field label="思考强度 ID" hint="模型没有思考选项时留空。" value={worker.thinkingOptionId} onChange={(thinkingOptionId) => setWorker((current) => ({ ...current, thinkingOptionId }))} styles={styles} disabled={disabled} maxLength={80} />
      <View style={styles.wrap}>
        {model?.thinking.map((thinkingOptionId) => <Button key={thinkingOptionId} label={thinkingOptionId} selected={thinkingOptionId === worker.thinkingOptionId} styles={styles} disabled={disabled}
          onPress={() => setWorker((current) => ({ ...current, thinkingOptionId }))} />)}
      </View>
      <Field label="模型功能（JSON）" hint='例如 {"service_tier":"priority"}。这些值会传给所选 provider；启用监听或启动分析前由 daemon 校验。' value={features} onChange={setFeatures} multiline styles={styles} disabled={disabled} maxLength={4000} />
      <Field label="分析超时（秒）" hint="60–7200 秒。超时后保留失败记录，可手动重试。" value={timeout} onChange={setTimeout} numeric styles={styles} disabled={disabled} />
      <ErrorText error={error} styles={styles} />
      <View style={styles.wrap}>
        <Button label={disabled ? "正在保存…" : "保存设置"} styles={styles} primary disabled={disabled} onPress={() => void submit()} />
        <Button label="取消编辑" styles={styles} disabled={disabled} onPress={onCancel} />
      </View>
    </View>
  );
}

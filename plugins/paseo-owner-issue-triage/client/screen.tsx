import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { configureRpc, diagnosticRpc, intakeRpc, overviewRpc, scanRpc } from "../shared/rpc";
import { RepoSchema, VERSION, type Item, type Overview } from "../shared/types";
import { IssueRow } from "./issue-row";
import { SettingsForm } from "./settings";
import { Button, createStyles, dateLabel, ErrorText, Field, overviewKey, Section, STATUSES, STATUS_LABELS, type Styles, useOverviewAction } from "./ui";

export function TriageScreen({ theme, layout, navigation }: PluginScreenProps) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const read = useRpc(overviewRpc);
  const overview = useQuery({ queryKey: overviewKey, queryFn: () => read({}), refetchInterval: 5000 });
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {overview.data ? <Dashboard data={overview.data} styles={styles} theme={theme} navigation={navigation} /> : overview.isPending ?
        <View style={styles.row}><ActivityIndicator color={theme.colors.accent} /><Text style={styles.text}>正在读取本人 issue 队列…</Text></View> : null}
      {overview.isError ? <View style={styles.section}>
        <ErrorText error={overview.error} styles={styles} />
        <View style={styles.wrap}><Button label="重新连接插件" styles={styles} disabled={overview.isFetching} onPress={() => void overview.refetch()} /></View>
      </View> : null}
    </ScrollView>
  );
}

function Dashboard({ data, styles, theme, navigation }: {
  data: Overview; styles: Styles; theme: PluginScreenProps["theme"]; navigation: PluginScreenProps["navigation"];
}) {
  const [settingsOpen, setSettingsOpen] = useState(!data.owner || data.config.repos.length === 0);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [filter, setFilter] = useState<Item["status"] | "all">("all");
  const [notice, setNotice] = useState("");
  const scan = useOverviewAction(useRpc(scanRpc));
  const configure = useOverviewAction(useRpc(configureRpc));
  const githubItems = data.items.filter((item) => item.source === "github");
  const fixtureItems = data.items.filter((item) => item.source === "diagnostic");
  const items = filter === "all" ? githubItems : githubItems.filter((item) => item.status === filter);
  const backingOff = data.scan.failures > 0 && data.scan.nextAt > Date.now();
  const toggleEnabled = async () => {
    setNotice("");
    try {
      await configure.mutateAsync({ config: { ...data.config, enabled: !data.config.enabled } });
      setNotice(data.config.enabled ? "自动监听已暂停。" : "自动监听已开启。");
    } catch { /* Error is rendered beside the action. */ }
  };
  return (
    <>
      <View style={styles.section}>
        <View style={styles.between}><Text style={styles.heading}>本人 issues</Text><Text style={styles.muted}>Owner triage / v{data.version || VERSION}</Text></View>
        <Text style={styles.text}>只读 GitHub，自动分析你创建的 issue，并在 Paseo 留下分析记录。</Text>
        <Text style={styles.muted}>仅接受绑定 numeric ID 的作者；不评论、不打标签、不关闭 issue。</Text>
        <View style={styles.between}>
          <View style={styles.section}>
            <Text style={styles.label}>{data.owner ? `绑定账号：${data.owner.login}` : "尚未绑定 GitHub 账号"}</Text>
            <Text style={styles.muted}>{data.owner ? `GitHub numeric ID：${data.owner.id}` : "保存设置后，通过 daemon 的 gh 登录读取真实账号 ID。"}</Text>
          </View>
          <View style={styles.wrap}>
            <Button label={data.config.enabled ? "暂停自动监听" : "开启自动监听"} styles={styles} primary={!data.config.enabled} disabled={configure.isPending || settingsOpen || !data.owner || data.config.repos.length === 0} onPress={() => void toggleEnabled()} />
            <Button label={data.scanning || scan.isPending ? "正在扫描…" : backingOff ? "扫描退避中" : "立即扫描"} styles={styles} disabled={scan.isPending || data.scanning || backingOff || !data.owner || data.config.repos.length === 0} onPress={() => void scan.mutateAsync({}).catch(() => undefined)} />
            <Button label={settingsOpen ? "正在编辑设置" : "编辑设置"} styles={styles} disabled={settingsOpen || configure.isPending} onPress={() => { setSettingsOpen(true); setNotice(""); }} />
          </View>
        </View>
        <ErrorText error={configure.error ?? scan.error} styles={styles} />
        {notice ? <Text style={styles.success}>{notice}</Text> : null}
      </View>

      <View style={styles.panel}>
        <View style={styles.between}>
          <Text style={styles.label}>{data.scanning ? "正在扫描 GitHub" : data.config.enabled ? "自动监听已开启" : "自动监听已暂停"}</Text>
          <Text style={styles.muted}>每 {data.config.pollSeconds} 秒扫描；页面每 5 秒刷新</Text>
        </View>
        <Text style={styles.muted}>最近成功：{dateLabel(data.scan.lastSucceededAt)}</Text>
        <Text style={styles.muted}>下次扫描：{data.config.enabled ? data.scan.nextAt ? dateLabel(data.scan.nextAt) : "即将扫描" : "自动监听暂停后不再定时扫描"}</Text>
        {!data.config.enabled && backingOff ? <Text style={styles.warning}>GitHub 退避至 {dateLabel(data.scan.nextAt)}，之后可手动扫描。</Text> : null}
        {data.scan.lastStartedAt ? <Text style={styles.muted}>最近开始：{dateLabel(data.scan.lastStartedAt)}{data.scan.failures ? `；连续失败 ${data.scan.failures} 次` : ""}</Text> : null}
        <ErrorText error={data.scan.error ? `扫描失败：${data.scan.error}` : null} styles={styles} />
        <ErrorText error={data.workerError ? `分析 worker：${data.workerError}` : null} styles={styles} />
        <Text style={styles.muted}>仓库：{data.config.repos.length ? data.config.repos.join("、") : "尚未配置白名单"}</Text>
      </View>

      {settingsOpen ? <SettingsForm config={data.config} styles={styles} onCancel={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); setNotice("设置已保存，身份与队列状态已刷新。"); }} /> : null}

      <Section title="Issue 队列" styles={styles} hint="新内容进入待处理队列；历史发现项可以手动开始 triage。人工接管后暂停自动处理该 issue。">
        {!data.config.enabled ? <Text style={styles.warning}>自动监听已暂停。手动 triage 可以排队，开启监听后才会启动 GitHub issue 的分析。</Text> : null}
        <View style={styles.wrap}>
          <Button label={`全部 ${githubItems.length}`} styles={styles} selected={filter === "all"} onPress={() => setFilter("all")} />
          {STATUSES.map((status) => <Button key={status} label={`${STATUS_LABELS[status]} ${githubItems.filter((item) => item.status === status).length}`} styles={styles} selected={filter === status} onPress={() => setFilter(status)} />)}
        </View>
        <View style={styles.wrap}><Button label={intakeOpen ? "收起手动发现" : "手动发现 issue"} styles={styles} onPress={() => setIntakeOpen((value) => !value)} /></View>
        {intakeOpen ? <IntakeForm styles={styles} repos={data.config.repos} /> : null}
        {items.length ? items.map((item) => <IssueRow key={item.key} item={item} styles={styles} theme={theme} navigation={navigation} />)
          : <View style={styles.panel}><Text style={styles.text}>{githubItems.length ? "这个状态下没有 issue。" : "还没有发现本人 issue。"}</Text>
            <Text style={styles.muted}>{githubItems.length ? "切换状态查看其他条目。" : "设置仓库白名单后扫描，或按仓库与编号手动发现。其他作者的 issue 和 PR 不会进入此队列。"}</Text></View>}
      </Section>

      <Section title="本地诊断" styles={styles}>
        <Text style={styles.muted}>本地测试 fixture，不是 GitHub issue。测试使用 daemon 可用的低成本模型，验证实际 agent 流程。</Text>
        <View style={styles.wrap}><Button label={diagnosticOpen ? "收起诊断工具" : `打开诊断工具${fixtureItems.length ? ` (${fixtureItems.length})` : ""}`} styles={styles} onPress={() => setDiagnosticOpen((value) => !value)} /></View>
        {diagnosticOpen ? <DiagnosticPanel items={fixtureItems} styles={styles} theme={theme} navigation={navigation} /> : null}
      </Section>
    </>
  );
}

function IntakeForm({ repos, styles }: { repos: string[]; styles: Styles }) {
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [number, setNumber] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const intake = useOverviewAction(useRpc(intakeRpc));
  const submit = async () => {
    setError(null); setNotice("");
    try {
      const parsed = RepoSchema.safeParse(repo);
      if (!parsed.success) throw new Error("请填写 owner/repository 格式的仓库名。");
      if (!repos.includes(parsed.data)) throw new Error("请先把这个仓库加入设置中的白名单。");
      if (!/^[1-9]\d*$/.test(number.trim()) || !Number.isSafeInteger(Number(number))) throw new Error("Issue 编号需要填写正整数。");
      await intake.mutateAsync({ repo: parsed.data, number: Number(number) });
      setNotice("已验证作者并更新本地发现记录；未直接派发分析。");
    } catch (cause) { setError(cause); }
  };
  return <View style={styles.panel}>
    <Text style={styles.label}>手动发现本人 issue</Text>
    <Text style={styles.muted}>先核对作者和白名单，加入发现记录；之后由你点击「开始 triage」。</Text>
    <Field label="Issue 仓库" value={repo} onChange={setRepo} styles={styles} disabled={intake.isPending} placeholder="owner/repository" />
    <Field label="Issue 编号" value={number} onChange={setNumber} styles={styles} numeric disabled={intake.isPending} maxLength={16} placeholder="例如 12" />
    <ErrorText error={error} styles={styles} />
    {notice ? <Text style={styles.success}>{notice}</Text> : null}
    <View style={styles.wrap}><Button label={intake.isPending ? "正在验证作者…" : "发现 issue"} styles={styles} disabled={intake.isPending} onPress={() => void submit()} /></View>
  </View>;
}

function DiagnosticPanel({ items, styles, theme, navigation }: {
  items: Item[]; styles: Styles; theme: PluginScreenProps["theme"]; navigation: PluginScreenProps["navigation"];
}) {
  const diagnostic = useOverviewAction(useRpc(diagnosticRpc));
  const [notice, setNotice] = useState("");
  const active = items.some((item) => item.status === "analyzing" || item.status === "queued");
  const run = async (action: "run" | "cleanup") => {
    setNotice("");
    try {
      await diagnostic.mutateAsync({ action });
      setNotice(action === "cleanup" ? "诊断清理已完成。" : "诊断已启动，结果会自动刷新。");
    } catch { /* The mutation error remains visible. */ }
  };
  return <View style={styles.panel}>
    <View style={styles.wrap}>
      <Button label={active ? "诊断正在运行" : "运行本地诊断"} styles={styles} disabled={diagnostic.isPending || active || items.length > 0} onPress={() => void run("run")} />
      <Button label="清理测试 agent 与记录" styles={styles} disabled={diagnostic.isPending || items.length === 0} onPress={() => void run("cleanup")} />
    </View>
    <Text style={styles.muted}>清理会停止并归档测试 agent，删除此处的测试记录。</Text>
    <ErrorText error={diagnostic.error} styles={styles} />
    {notice ? <Text style={styles.success}>{notice}</Text> : null}
    {items.map((item) => <IssueRow key={item.key} item={item} styles={styles} theme={theme} navigation={navigation} />)}
  </View>;
}

import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Linking, Text, View } from "react-native";
import { itemActionRpc } from "../shared/rpc";
import type { Item, TriageResult } from "../shared/types";
import { Button, dateLabel, ErrorText, STATUS_LABELS, type Styles, type Theme, useOverviewAction } from "./ui";

const CATEGORIES: Record<TriageResult["category"], string> = {
  bug: "缺陷", feature: "功能", docs: "文档", question: "问题", maintenance: "维护", unknown: "待判断",
};
const CONFIDENCE: Record<TriageResult["confidence"], string> = { low: "低", medium: "中", high: "高" };

function issueUrl(item: Item): string | null {
  const { repo, number, url } = item.snapshot;
  if (item.source !== "github" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null;
  const expected = `https://github.com/${repo}/issues/${number}`;
  return url.toLowerCase() === expected.toLowerCase() ? expected : null;
}

export function IssueRow({ item, styles, theme, navigation }: {
  item: Item; styles: Styles; theme: Theme; navigation: PluginScreenProps["navigation"];
}) {
  const action = useOverviewAction(useRpc(itemActionRpc));
  const [linkError, setLinkError] = useState<unknown>(null);
  const [showHistory, setShowHistory] = useState(false);
  const result = item.run?.result;
  const working = item.status === "queued" || item.status === "analyzing";
  const active = working || item.run?.phase === "reserved" || item.run?.phase === "running";
  const closed = item.status === "closed" || item.snapshot.state === "closed";
  const contentChanged = Boolean(item.run && item.run.fingerprint !== item.snapshot.fingerprint);
  const canTriage = !item.claimed && !closed && !active && (item.status === "discovered" || (item.status === "completed" && item.processedFingerprint !== item.snapshot.fingerprint));
  const url = issueUrl(item);
  const statusColor = item.status === "failed" ? theme.colors.statusDanger
    : item.status === "completed" ? theme.colors.statusSuccess
    : working ? theme.colors.accent : theme.colors.foregroundMuted;
  const act = (kind: "triage" | "retry" | "claim" | "release") => {
    void action.mutateAsync({ key: item.key, action: kind, ...(kind === "claim" ? { note: "人工已接管" } : {}) }).catch(() => undefined);
  };
  const openIssue = () => {
    if (!url) return;
    setLinkError(null);
    void Linking.openURL(url).catch(setLinkError);
  };
  return (
    <View style={styles.issue}>
      <View style={styles.between}>
        <Text style={styles.muted} selectable>{item.source === "diagnostic" ? "本地测试 fixture，不是 GitHub issue" : `${item.snapshot.repo} #${item.snapshot.number}`}</Text>
        <View style={[styles.tag, { borderColor: statusColor }]}><Text style={[styles.tagText, { color: statusColor }]}>{STATUS_LABELS[item.status]}</Text></View>
      </View>
      <Text style={styles.title} selectable>{item.snapshot.title}</Text>
      <Text style={styles.muted}>最近更新 {dateLabel(item.updatedAt)}{item.retryAt ? `；下次重试 ${dateLabel(item.retryAt)}` : ""}</Text>
      {item.claimed ? <Text style={styles.warning}>接管备注：{item.claimed}</Text> : null}
      {result ? <View style={styles.result}>
        {contentChanged ? <Text style={styles.warning}>这是上次内容的分析；issue 已有更新。</Text> : null}
        <View style={styles.wrap}>
          <Text style={styles.label}>{CATEGORIES[result.category]} / {result.priority}</Text>
          <Text style={styles.muted}>判断把握：{CONFIDENCE[result.confidence]}</Text>
        </View>
        <Text style={styles.muted}>涉及插件：{result.plugins.length ? result.plugins.join("、") : "尚未确定"}</Text>
        <Text style={styles.text} selectable>{result.summary}</Text>
        {result.nextSteps.length ? <Text style={styles.label}>建议处理路径</Text> : null}
        {result.nextSteps.map((step, index) => <View style={styles.step} key={`${index}-${step.slice(0, 40)}`}>
          <Text style={styles.muted}>{index + 1}.</Text><Text style={[styles.text, styles.grow]} selectable>{step}</Text>
        </View>)}
      </View> : null}
      <ErrorText error={item.error ?? item.run?.error} styles={styles} />
      <ErrorText error={action.error ?? linkError} styles={styles} />
      <View style={styles.wrap}>
        {canTriage ? <Button label={contentChanged ? "分析更新内容" : "开始 triage"} primary styles={styles} disabled={action.isPending} onPress={() => act("triage")} /> : null}
        {item.status === "failed" && !closed ? <Button label="重试 triage" primary styles={styles} disabled={action.isPending || active} onPress={() => act("retry")} /> : null}
        {item.status === "claimed" ? <Button label="解除人工接管" styles={styles} disabled={action.isPending || active} onPress={() => act("release")} />
          : !closed ? <Button label={item.status === "analyzing" ? "停止分析并接管" : item.status === "queued" ? "取消排队并接管" : "人工接管"} styles={styles} disabled={action.isPending} onPress={() => act("claim")} /> : null}
        {item.run?.agentId ? <Button label="打开分析 agent" styles={styles} disabled={!navigation} onPress={() => navigation?.openAgent({ agentId: item.run!.agentId })} /> : null}
        {url ? <Button label="打开原 issue" styles={styles} onPress={openIssue} /> : null}
        {item.history.length ? <Button label={`${showHistory ? "收起" : "查看"}历史分析 (${item.history.length})`} styles={styles} onPress={() => setShowHistory((value) => !value)} />
          : <Text style={styles.muted}>历史分析 0 次</Text>}
      </View>
      {working ? <Text style={styles.muted}>{item.status === "analyzing" ? "分析正在进行；完成后结果会自动显示。" : "已入队，等待可用 worker。"}</Text> : null}
      {showHistory ? <View style={styles.panel}>
        {item.history.map((run) => <View key={run.id} style={styles.section}>
          <View style={styles.between}>
            <Text style={styles.muted}>{dateLabel(run.startedAt)} / {run.phase === "completed" ? "已完成" : run.phase === "failed" ? "失败" : "处理中"}</Text>
            {run.agentId ? <Button label={`打开第 ${run.attempt} 次分析`} styles={styles} disabled={!navigation} onPress={() => navigation?.openAgent({ agentId: run.agentId })} /> : null}
          </View>
          {run.result ? <Text style={styles.text} selectable>{run.result.summary}</Text> : null}
          <ErrorText error={run.error} styles={styles} />
        </View>)}
      </View> : null}
    </View>
  );
}

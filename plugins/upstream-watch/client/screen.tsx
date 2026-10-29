import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import {
  checkRpc,
  discoveryRpc,
  overviewRpc,
  pendingCount,
  settingsRpc,
  type WatchDraft,
} from "../shared/contracts";
import { Badge, Body, Button, Field, Panel, Row, Tabs, Title } from "./kit";
import { WatchForm } from "./watch-form";
import { WatchCard } from "./watch-card";
import { cindyDraft } from "../shared/cindy";
import { taskIntent } from "../shared/feature-review";

type Tab = "watches" | "discovery" | "settings";
const tabs: { id: Tab; label: string }[] = [
  { id: "watches", label: "关注的上游" },
  { id: "discovery", label: "发现来源" },
  { id: "settings", label: "检查设置" },
];
export const overviewKey = ["upstream-watch", "overview"];
export function UpstreamScreen(props: PluginScreenProps) {
  const { theme, layout } = props;
  const [tab, setTab] = useState<Tab>(
    props.params.tab === "settings" ? "settings" : "watches",
  );
  const [form, setForm] = useState<Partial<WatchDraft> | null>(null);
  const [filter, setFilter] = useState<"all" | "pending">("all");
  const [root, setRoot] = useState("");
  const getOverview = useRpc(overviewRpc),
    check = useRpc(checkRpc),
    discover = useRpc(discoveryRpc),
    saveSettings = useRpc(settingsRpc);
  const client = useQueryClient();
  const overview = useQuery({
    queryKey: overviewKey,
    queryFn: () => getOverview({}),
    refetchInterval: (query) =>
      query.state.data?.checking ||
      query.state.data?.tasks.some((task) => task.status === "preparing")
        ? 1500
        : 15_000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: overviewKey });
  const checkMutation = useMutation({
    mutationFn: () => check({}),
    onSuccess: refresh,
  });
  const discovery = useMutation({
    mutationFn: () => discover({ root: root.trim() || undefined }),
  });
  const settings = useMutation({
    mutationFn: saveSettings,
    onSuccess: refresh,
  });
  const count = pendingCount(overview.data?.watches || []);
  const watches = (overview.data?.watches || [])
    .filter(
      (watch) =>
        filter === "all" || (watch.enabled && watch.observation?.hasUpdate),
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.observation?.hasUpdate)) -
          Number(Boolean(a.observation?.hasUpdate)) ||
        a.name.localeCompare(b.name),
    );
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 16 : 28,
        gap: 18,
        maxWidth: 1100,
        width: "100%",
        alignSelf: "center",
        paddingBottom: 60,
      }}
    >
      <View style={{ gap: 8 }}>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 26,
            fontWeight: "600",
          }}
        >
          插件的上游更新
        </Text>
        <Body theme={theme} muted>
          跟踪 fork、参考项目与核心功能，让 agent 提建议或按选择执行适配。
        </Body>
        <Row>
          <Button
            theme={theme}
            label={overview.data?.checking ? "正在检查上游…" : "立即检查上游"}
            icon="RefreshCw"
            busy={checkMutation.isPending || overview.data?.checking}
            onPress={() => checkMutation.mutate()}
          />
          <Button
            theme={theme}
            label="添加上游关联"
            icon="Plus"
            primary
            onPress={() => {
              setForm({});
              setTab("watches");
            }}
          />
          <Badge
            theme={theme}
            label={`${count} 项待处理`}
            warning={count > 0}
          />
          <Button
            theme={theme}
            label="从 Cindy 核心清单开始"
            onPress={() => {
              const existing = overview.data?.watches.find(
                (watch) =>
                  watch.repository.toLowerCase() === "makecindy/cindy" &&
                  watch.pluginId === "cindy-companion",
              );
              setForm(existing || cindyDraft());
              setTab("watches");
            }}
          />
        </Row>
      </View>
      <Tabs<Tab> theme={theme} items={tabs} value={tab} onChange={setTab} />
      {overview.error ? (
        <Panel theme={theme}>
          <Body theme={theme}>无法读取上游记录：{String(overview.error)}</Body>
          <Button
            theme={theme}
            label="重试读取上游记录"
            onPress={() => overview.refetch()}
          />
        </Panel>
      ) : null}
      {overview.isLoading ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : null}
      {checkMutation.error ? (
        <Body theme={theme}>{String(checkMutation.error)}</Body>
      ) : null}
      {tab === "watches" ? (
        <View style={{ gap: 12 }}>
          {form ? (
            <WatchForm
              key={form.id || form.repository || "new"}
              theme={theme}
              initial={form}
              close={() => setForm(null)}
            />
          ) : null}
          {(overview.data?.watches.length || 0) > 0 ? (
            <Tabs<"all" | "pending">
              theme={theme}
              value={filter}
              items={[
                { id: "all", label: `全部 ${overview.data?.watches.length}` },
                { id: "pending", label: `待处理 ${count}` },
              ]}
              onChange={setFilter}
            />
          ) : null}
          {!overview.isLoading && !overview.error && watches.length === 0 ? (
            <Panel theme={theme}>
              <Title theme={theme}>
                {filter === "pending"
                  ? "当前没有待处理的上游变化"
                  : "先为插件登记一个上游"}
              </Title>
              <Body theme={theme} muted>
                {filter === "pending"
                  ? "新变化会保留在这里，直到你明确标记已处理。"
                  : "可以手动填写 GitHub 仓库与已采用的 commit，也可以从插件的来源记录开始。"}
              </Body>
              {filter === "all" ? (
                <Button
                  theme={theme}
                  label="发现插件来源记录"
                  icon="ScanSearch"
                  onPress={() => {
                    setTab("discovery");
                    discovery.mutate();
                  }}
                />
              ) : null}
            </Panel>
          ) : null}
          {watches.map((watch) => (
            <WatchCard
              key={watch.id}
              {...props}
              watch={watch}
              task={overview.data?.tasks.find(
                (task) =>
                  task.watchId === watch.id &&
                  task.intent === taskIntent(watch) &&
                  task.head === watch.observation?.head,
              )}
              edit={(draft) => setForm(draft)}
            />
          ))}
          {overview.data ? (
            <Body theme={theme} muted>
              {overview.data.settings.enabled
                ? `后台每 ${overview.data.settings.intervalHours} 小时检查一次`
                : "定时检查已暂停"}
              。检查不调用模型；只有你点按钮才创建 agent。
            </Body>
          ) : null}
        </View>
      ) : null}
      {tab === "discovery" ? (
        <View style={{ gap: 14 }}>
          <Panel theme={theme}>
            <Title theme={theme}>从明确的来源记录开始</Title>
            <Body theme={theme} muted>
              读取 UPSTREAM.json、SOURCE.json 和 Git
              remote，作为待确认候选。没有采用版本的记录会明确留空。
            </Body>
            <Field
              theme={theme}
              placeholder="可选：同时扫描本地插件仓库（绝对路径）"
              value={root}
              onChange={setRoot}
            />
            <Button
              theme={theme}
              label="扫描插件来源"
              icon="ScanSearch"
              busy={discovery.isPending}
              onPress={() => discovery.mutate()}
            />
          </Panel>
          {discovery.error ? (
            <Body theme={theme}>{String(discovery.error)}</Body>
          ) : null}
          {discovery.data?.map((plugin) => (
            <Panel key={plugin.id} theme={theme}>
              <Title theme={theme}>{plugin.name}</Title>
              <Body theme={theme} muted>
                {plugin.note}
              </Body>
              <Body theme={theme} mono>
                {plugin.targetPath || plugin.installedPath}
              </Body>
              {plugin.sources.length ? (
                plugin.sources.map((source, index) => (
                  <View
                    key={`${source.repository}-${index}`}
                    style={{ gap: 7, paddingTop: 8 }}
                  >
                    <Body theme={theme}>
                      {source.repository}　
                      {source.paths.length ? source.paths.join("、") : "全仓库"}
                    </Body>
                    <Body theme={theme} muted>
                      {source.baseline
                        ? `参考基线 ${source.baseline.slice(0, 12)}`
                        : "采用基线未知：登记时可填写，或从当前版本开始跟踪"}
                    </Body>
                    <Button
                      theme={theme}
                      label={`跟踪 ${source.repository}`}
                      onPress={() => {
                        setForm({
                          ...source,
                          name: `${plugin.name} / ${source.repository.split("/").pop()}`,
                          pluginId: plugin.id,
                          targetPath: plugin.targetPath || "",
                          enabled: true,
                          provider: "",
                        });
                        setTab("watches");
                      }}
                    />
                  </View>
                ))
              ) : (
                <Body theme={theme} muted>
                  没有发现可确认的 GitHub 上游，可以手动添加。
                </Body>
              )}
            </Panel>
          ))}
          {discovery.isSuccess && discovery.data.length === 0 ? (
            <Body theme={theme}>
              没有找到来源记录。可添加本地源码仓库路径，或手动登记关联。
            </Body>
          ) : null}
        </View>
      ) : null}
      {tab === "settings" && overview.data ? (
        <Panel theme={theme}>
          <Title theme={theme}>后台检查</Title>
          <SettingsSwitch
            label="定时检查上游"
            value={overview.data.settings.enabled}
            onValueChange={(enabled) =>
              settings.mutate({ ...overview.data!.settings, enabled })
            }
            disabled={settings.isPending}
          />
          <SettingsSelect
            label="检查间隔"
            value={String(overview.data.settings.intervalHours)}
            options={[
              { value: "1", label: "每小时" },
              { value: "6", label: "每 6 小时" },
              { value: "24", label: "每天" },
              { value: "168", label: "每周" },
            ]}
            onValueChange={(hours) =>
              settings.mutate({
                ...overview.data!.settings,
                intervalHours: Number(hours),
              })
            }
            disabled={settings.isPending}
          />
          <Body theme={theme} muted>
            检查在 daemon
            上执行，页面关闭后也会继续。未处理变化显示在侧栏数量与列表里。
          </Body>
          <Body theme={theme} muted>
            GitHub 访问：
            {overview.data.authentication === "gh"
              ? "使用本机 gh 的已有登录"
              : "匿名访问（请求限额较低）"}
            。失败或限流时保留上次结果并显示原因。
          </Body>
          <Body theme={theme} muted>
            这版支持 GitHub 仓库。Paseo 0.12
            没有公开通用系统推送接口，当前提醒为应用内徽标和列表。
          </Body>
          {settings.error ? (
            <Body theme={theme}>{String(settings.error)}</Body>
          ) : null}
        </Panel>
      ) : null}
    </ScrollView>
  );
}

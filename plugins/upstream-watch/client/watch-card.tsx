import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  acknowledgeRpc,
  checkRpc,
  launchRpc,
  removeRpc,
  retryTaskRpc,
  saveRpc,
  type Watch,
  type WatchDraft,
  type UpdateTask,
} from "../shared/contracts";
import { AgentPicker } from "./agent-picker";
import { Badge, Body, Button, Row, Title } from "./kit";
import { ReviewReport } from "./feature-review";

const relationships = {
  fork: "Fork 上游",
  reference: "参考项目",
  feature: "参考功能",
};
export function WatchCard({
  watch,
  task,
  theme,
  navigation,
  host,
  edit,
}: Pick<PluginScreenProps, "theme" | "navigation" | "host"> & {
  watch: Watch;
  task?: UpdateTask;
  edit(value: WatchDraft): void;
}) {
  const client = useQueryClient();
  const acknowledge = useRpc(acknowledgeRpc),
    check = useRpc(checkRpc),
    launch = useRpc(launchRpc),
    remove = useRpc(removeRpc),
    save = useRpc(saveRpc),
    retry = useRpc(retryTaskRpc);
  const [action, setAction] = useState<"ack" | "remove" | "launch" | null>(
    null,
  );
  const [ackHead, setAckHead] = useState<string>();
  const [details, setDetails] = useState(false);
  const [selection, setSelection] = useState({
    workspaceId: watch.workspaceId || "",
    provider: watch.provider,
  });
  useEffect(() => {
    setSelection({
      workspaceId: watch.workspaceId || "",
      provider: watch.provider,
    });
  }, [watch.workspaceId, watch.provider]);
  const refresh = () =>
    client.invalidateQueries({ queryKey: ["upstream-watch", "overview"] });
  const mutation = useMutation({
    mutationFn: async (
      kind: "ack" | "check" | "launch" | "remove" | "toggle" | "retry",
    ) => {
      if (kind === "ack") {
        if (!ackHead) throw new Error("请重新确认要处理的版本");
        await acknowledge({ id: watch.id, head: ackHead });
      }
      if (kind === "check") await check({ id: watch.id });
      if (kind === "remove") await remove({ id: watch.id });
      if (kind === "toggle") await save({ ...watch, enabled: !watch.enabled });
      if (kind === "retry" && task) await retry({ taskId: task.id });
      if (kind === "launch") {
        await launch({
          watchId: watch.id,
          head: watch.observation!.head,
          ...selection,
        });
      }
    },
    onSuccess: async () => {
      setAction(null);
      await refresh();
    },
  });
  const observation = watch.observation;
  const pending = observation?.hasUpdate;
  const reviewing = Boolean(watch.review);
  const agentLabel = reviewing ? "建议 agent" : "更新 agent";
  const status = !watch.enabled
    ? "已暂停"
    : watch.error
      ? "检查失败"
      : !observation
        ? "等待首次检查"
        : observation.needsReview
          ? "需要人工核对"
          : pending
            ? "有相关更新"
            : reviewing
              ? "本次无新增差异"
              : "已跟上";
  const openAgent = () => {
    if (task?.agentId)
      navigation?.openAgent({ agentId: task.agentId, serverId: host.id });
  };
  return (
    <View
      style={{
        paddingVertical: 20,
        gap: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Row>
        <Title theme={theme}>{watch.name}</Title>
        <Badge
          theme={theme}
          label={status}
          warning={Boolean(watch.error || pending)}
        />
        <Badge theme={theme} label={relationships[watch.relationship]} />
        {reviewing ? <Badge theme={theme} label="仅建议" /> : null}
      </Row>
      <ExternalLink href={`https://github.com/${watch.repository}`}>
        <Text style={{ color: theme.colors.accent, fontSize: 14 }}>
          {watch.repository} / {observation?.ref || watch.ref || "默认分支"}
        </Text>
      </ExternalLink>
      <Body theme={theme} muted>
        {watch.targetPath}
      </Body>
      <Body theme={theme} muted>
        关注：{watch.paths.length ? watch.paths.join("、") : "整个仓库"}
        {"　"}上次检查：
        {watch.checkedAt
          ? new Date(watch.checkedAt).toLocaleString()
          : "尚未检查"}
      </Body>
      {watch.error ? (
        <Text
          selectable
          style={{
            color: theme.colors.statusDanger,
            fontSize: 13,
            lineHeight: 20,
          }}
        >
          {watch.error}
          {watch.retryAt
            ? `；可重试时间 ${new Date(watch.retryAt).toLocaleString()}`
            : ""}
          。保留上次成功结果。
        </Text>
      ) : null}
      {observation ? (
        <View
          style={{
            padding: 12,
            gap: 7,
            backgroundColor: theme.colors.surface1,
            borderRadius: 7,
          }}
        >
          <Row>
            <Body theme={theme} mono>
              {watch.baseline?.slice(0, 8) || "未设基线"} →{" "}
              {observation.head.slice(0, 8)}
            </Body>
            <ExternalLink href={observation.compareUrl || observation.url}>
              <Text style={{ color: theme.colors.accent, fontSize: 13 }}>
                查看上游差异
              </Text>
            </ExternalLink>
          </Row>
          <Body theme={theme}>
            {observation.needsReview
              ? "上游历史或文件列表不完整，需要核对后再决定如何适配。"
              : pending
                ? `${observation.commitsTotal} 个上游提交；${watch.paths.length ? `涉及关注范围 ${observation.matchedPaths.length} 个文件` : `涉及 ${observation.files.length} 个文件`}`
                : "当前关注范围内没有未处理变化。"}
          </Body>
          {pending
            ? observation.commits.slice(0, 3).map((commit) => (
                <Body key={commit.sha} theme={theme} muted>
                  {commit.sha.slice(0, 7)}　{commit.title}
                </Body>
              ))
            : null}
          {details ? (
            <View style={{ gap: 6 }}>
              <Body theme={theme} muted>
                {watch.notes || "未填写适配说明"}
              </Body>
              {observation.files.slice(0, 30).map((file) => (
                <Body key={file.path} theme={theme} mono>
                  {file.status}　
                  {file.previousPath ? `${file.previousPath} → ` : ""}
                  {file.path}
                </Body>
              ))}
              {observation.filesTruncated ? (
                <Body theme={theme}>
                  文件列表被上游 API 截断，请查看完整差异。
                </Body>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
      {reviewing ? (
        <Button
          theme={theme}
          label={
            details
              ? "收起核心功能对照"
              : `查看 ${watch.review!.features.length} 项核心功能对照`
          }
          onPress={() => setDetails((value) => !value)}
        />
      ) : null}
      {details && reviewing ? (
        <ReviewReport theme={theme} watch={watch} />
      ) : null}
      {task ? (
        <View style={{ gap: 7 }}>
          <Body theme={theme}>
            {task.status === "created"
              ? `已创建${agentLabel}：${task.title}`
              : task.status === "preparing"
                ? `正在创建${agentLabel}…`
                : `任务创建待确认：${task.error || "连接中断"}`}
          </Body>
          {task.agentId && navigation ? (
            <Button
              theme={theme}
              label={`查看${agentLabel}`}
              icon="ArrowUpRight"
              onPress={openAgent}
            />
          ) : task.status === "uncertain" || task.status === "failed" ? (
            <Button
              theme={theme}
              label="用同一任务重试创建"
              disabled={mutation.isPending}
              onPress={() => mutation.mutate("retry")}
            />
          ) : null}
        </View>
      ) : null}
      <Row>
        {(pending || (reviewing && observation)) &&
        watch.enabled &&
        !watch.error &&
        !task ? (
          <Button
            theme={theme}
            label={`开${agentLabel}`}
            icon="Bot"
            primary
            busy={mutation.isPending}
            onPress={() =>
              selection.workspaceId && selection.provider
                ? mutation.mutate("launch")
                : setAction(action === "launch" ? null : "launch")
            }
          />
        ) : null}
        {pending && !watch.error ? (
          <Button
            theme={theme}
            label="标记已处理 / 跳过"
            onPress={() => {
              setAckHead(observation?.head);
              setAction("ack");
            }}
          />
        ) : null}
        <Button
          theme={theme}
          label="检查此上游"
          icon="RefreshCw"
          busy={mutation.isPending}
          onPress={() => mutation.mutate("check")}
        />
        <Button
          theme={theme}
          label={details ? "收起差异" : "变更详情"}
          onPress={() => setDetails((value) => !value)}
        />
        <Button theme={theme} label="编辑关联" onPress={() => edit(watch)} />
        <Button
          theme={theme}
          label={watch.enabled ? "暂停此跟踪" : "恢复此跟踪"}
          onPress={() => mutation.mutate("toggle")}
        />
        <Button
          theme={theme}
          label="删除关联"
          danger
          onPress={() => setAction("remove")}
        />
      </Row>
      {action === "launch" ? (
        <View
          style={{
            gap: 10,
            padding: 14,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
          }}
        >
          <AgentPicker
            theme={theme}
            value={selection}
            onChange={setSelection}
          />
          <Row>
            <Button
              theme={theme}
              label={`创建${agentLabel}`}
              primary
              disabled={!selection.workspaceId || !selection.provider}
              busy={mutation.isPending}
              onPress={() => mutation.mutate("launch")}
            />
            <Button
              theme={theme}
              label="取消创建"
              onPress={() => setAction(null)}
            />
          </Row>
        </View>
      ) : null}
      {action === "ack" ? (
        <View style={{ gap: 8 }}>
          <Body theme={theme}>
            将 {ackHead?.slice(0, 8)}{" "}
            设为已处理基线，以后只提示这之后的新变化。创建 agent
            本身不会推进基线。
          </Body>
          <Row>
            <Button
              theme={theme}
              label="确认已处理 / 跳过"
              busy={mutation.isPending}
              onPress={() => mutation.mutate("ack")}
            />
            <Button
              theme={theme}
              label="取消标记"
              onPress={() => setAction(null)}
            />
          </Row>
        </View>
      ) : null}
      {action === "remove" ? (
        <View style={{ gap: 8 }}>
          <Body theme={theme}>
            删除“{watch.name}”的跟踪记录？源仓库和插件代码不受影响。
          </Body>
          <Row>
            <Button
              theme={theme}
              label="确认删除关联"
              danger
              busy={mutation.isPending}
              onPress={() => mutation.mutate("remove")}
            />
            <Button
              theme={theme}
              label="保留关联"
              onPress={() => setAction(null)}
            />
          </Row>
        </View>
      ) : null}
      {mutation.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>
          {String(mutation.error)}
        </Text>
      ) : null}
    </View>
  );
}

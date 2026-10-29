import { useRpc } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { saveRpc, type WatchDraft } from "../shared/contracts";
import { AgentPicker } from "./agent-picker";
import { Body, Button, Field, Panel, Row, Title, type Themed } from "./kit";
import { ReviewEditor } from "./feature-review";

export function WatchForm({
  theme,
  initial,
  close,
}: Themed & { initial?: Partial<WatchDraft>; close(): void }) {
  const [draft, setDraft] = useState<WatchDraft>({
    name: "",
    pluginId: "",
    targetPath: "",
    repository: "",
    ref: "",
    paths: [],
    relationship: "reference",
    notes: "",
    enabled: true,
    provider: "",
    ...initial,
  });
  const [baseline, setBaseline] = useState(initial?.baseline || "");
  const [paths, setPaths] = useState(initial?.paths?.join("\n") || "");
  const [agentSetup, setAgentSetup] = useState(Boolean(initial?.workspaceId));
  const client = useQueryClient();
  const save = useRpc(saveRpc);
  const mutation = useMutation({
    mutationFn: () =>
      save({
        ...draft,
        baseline: baseline.trim() || undefined,
        paths: paths
          .split(/\r?\n/)
          .map((path) => path.trim())
          .filter(Boolean),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ["upstream-watch", "overview"],
      });
      close();
    },
  });
  const update = <K extends keyof WatchDraft>(key: K, value: WatchDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  return (
    <Panel theme={theme}>
      <Row>
        <Title theme={theme}>
          {draft.id ? "编辑上游关联" : "添加上游关联"}
        </Title>
        <Button theme={theme} label="收起表单" onPress={close} />
      </Row>
      <Body theme={theme} muted>
        同一个插件可以添加多条关联，分别跟踪 fork、参考项目和参考功能。
      </Body>
      <Body theme={theme}>关联名称</Body>
      <Field
        theme={theme}
        placeholder="例如：Learning Loop / Hermes 复盘机制"
        value={draft.name}
        onChange={(value) => update("name", value)}
      />
      <Body theme={theme}>本地插件开发目录</Body>
      <Field
        theme={theme}
        placeholder="插件源码的绝对路径"
        value={draft.targetPath}
        onChange={(value) => update("targetPath", value)}
      />
      <Body theme={theme}>上游 GitHub 仓库</Body>
      <Field
        theme={theme}
        placeholder="owner/repo 或 https://github.com/owner/repo"
        value={draft.repository}
        onChange={(value) => update("repository", value)}
      />
      <SettingsSelect
        label="关联类型"
        value={draft.relationship}
        options={[
          { value: "fork", label: "Fork 上游" },
          { value: "reference", label: "参考项目" },
          { value: "feature", label: "参考功能" },
        ]}
        onValueChange={(value) => update("relationship", value)}
      />
      <Body theme={theme}>跟踪分支 / tag（留空使用默认分支）</Body>
      <Field
        theme={theme}
        placeholder="例如 main；分支名含 / 时也可直接填写"
        value={draft.ref}
        onChange={(value) => update("ref", value)}
      />
      <Body theme={theme}>已采用或已处理的 commit</Body>
      <Field
        theme={theme}
        placeholder="40 位 SHA；留空从当前版本开始跟踪"
        value={baseline}
        onChange={setBaseline}
      />
      <Body theme={theme}>关注文件或目录（每行一个，留空关注全仓库）</Body>
      <Field
        theme={theme}
        placeholder="例如 agent/background_review.py"
        multiline
        value={paths}
        onChange={setPaths}
      />
      <Body theme={theme} muted>
        按文件名或目录前缀匹配，不使用
        glob。目录含子目录；重命名前后的路径都会检查。
      </Body>
      <Body theme={theme}>参考了什么、适配时应保留什么</Body>
      <Field
        theme={theme}
        placeholder="可选：要交给更新 agent 的说明"
        multiline
        value={draft.notes}
        onChange={(value) => update("notes", value)}
      />
      <SettingsSelect
        label="点击创建 agent 后的任务范围"
        value={draft.review ? "review" : "adapt"}
        options={[
          { value: "adapt", label: "实现适配" },
          { value: "review", label: "只提出移植建议" },
        ]}
        onValueChange={(value) =>
          update(
            "review",
            value === "review"
              ? {
                  mode: "recommend-only",
                  features: [
                    {
                      id: "core",
                      title: "核心功能",
                      upstreamPaths: ["src"],
                      localPaths: [],
                      adoption: "partial",
                      notes: "",
                    },
                  ],
                }
              : undefined,
          )
        }
      />
      {draft.review ? (
        <ReviewEditor
          theme={theme}
          review={draft.review}
          onChange={(review) => update("review", review)}
        />
      ) : null}
      <Button
        theme={theme}
        label={agentSetup ? "收起 agent 默认设置" : "设置 agent 的工作区与模型"}
        onPress={() => setAgentSetup((value) => !value)}
      />
      {agentSetup ? (
        <AgentPicker
          theme={theme}
          value={{
            workspaceId: draft.workspaceId || "",
            provider: draft.provider,
          }}
          onChange={(value) =>
            setDraft((current) => ({
              ...current,
              workspaceId: value.workspaceId || undefined,
              provider: value.provider,
            }))
          }
        />
      ) : null}
      {mutation.error ? (
        <Body theme={theme}>{String(mutation.error)}</Body>
      ) : null}
      <View style={{ alignItems: "flex-start" }}>
        <Button
          theme={theme}
          label="保存并检查"
          primary
          busy={mutation.isPending}
          disabled={
            !draft.name.trim() ||
            !draft.targetPath.trim() ||
            !draft.repository.trim()
          }
          onPress={() => mutation.mutate()}
        />
      </View>
    </Panel>
  );
}

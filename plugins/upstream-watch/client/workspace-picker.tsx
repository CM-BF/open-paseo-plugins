import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Body, Button, ErrorText, Field, Tabs, type Themed } from "./kit";
import { completeWorkspaceCreation, findWorkspaceCreation, prepareWorkspaceCreation, type WorkspaceChoice } from "./workspace-creation";

type PickerTab = "workspace" | "project";
const pickerTabs = [
  { id: "workspace", label: "已有 Workspace" },
  { id: "project", label: "从 Project 新建" },
] as const;

export function WorkspacePicker({
  theme,
  value,
  workspaces,
  projects,
  loading,
  refreshing,
  onChange,
  onCreated,
  onRefresh,
}: Themed & {
  value: string;
  workspaces: WorkspaceChoice[];
  projects: WorkspaceChoice[];
  loading: boolean;
  refreshing: boolean;
  onChange(workspaceId: string): void;
  onCreated(workspace: WorkspaceChoice, isCurrent: () => boolean): Promise<boolean>;
  onRefresh(): void;
}) {
  const paseo = usePaseo();
  const { height } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<PickerTab>("workspace");
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState("");
  const [creatingOwner, setCreatingOwner] = useState<object | null>(null);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);
  const currentOwner = useRef({ paseo, inFlight: false });
  if (currentOwner.current.paseo !== paseo) currentOwner.current = { paseo, inFlight: false };
  const owner = currentOwner.current;
  const currentValue = useRef(value);
  currentValue.current = value;
  const creating = creatingOwner === owner;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    setProjectId("");
    setError(null);
    setExpanded(false);
    setSearch("");
  }, [paseo]);
  const selected = workspaces.find((workspace) => workspace.id === value);
  const previous = findWorkspaceCreation(paseo, projectId);
  const selectedProject = previous?.project || projects.find((project) => project.id === projectId);
  const creationError = error || previous?.error;
  const query = search.trim().toLocaleLowerCase();
  const choices = (tab === "workspace" ? workspaces : projects).filter((choice) =>
    `${choice.name}\n${choice.directory}`.toLocaleLowerCase().includes(query),
  );

  async function createWorkspace() {
    if (owner.inFlight || !selectedProject) return;
    owner.inFlight = true;
    setCreatingOwner(owner);
    setError(null);
    const operation = prepareWorkspaceCreation(paseo, selectedProject);
    const ownsSurface = () => mounted.current && currentOwner.current === owner;
    const isCurrent = () => ownsSurface() && currentValue.current === value;
    try {
      const workspace = await operation.run();
      if (!isCurrent()) return;
      const applied = await onCreated(workspace, isCurrent);
      if (!applied) return;
      completeWorkspaceCreation(paseo, operation);
      if (!ownsSurface()) return;
      setExpanded(false);
      setSearch("");
      setTab("workspace");
    } catch (cause) {
      if (isCurrent()) setError(cause);
    } finally {
      owner.inFlight = false;
      if (ownsSurface()) setCreatingOwner(null);
    }
  }

  return (
    <View style={{ minWidth: 0, maxWidth: "100%", gap: 8 }}>
      <Body theme={theme}>更新任务工作区</Body>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="选择更新任务工作区"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        style={{
          minWidth: 0,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 7,
          backgroundColor: theme.colors.surface0,
          padding: 11,
          gap: 3,
        }}
      >
        <Text numberOfLines={1} style={{ minWidth: 0, color: theme.colors.foreground, fontSize: 13.5 }}>
          {selected?.name || (value ? "已选择的工作区暂不可用" : "选择工作区，或从 Project 新建")}
        </Text>
        {selected ? (
          <Text numberOfLines={2} ellipsizeMode="middle" style={{ minWidth: 0, color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {selected.directory}
          </Text>
        ) : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {expanded ? "收起选择" : "展开选择"}
        </Text>
      </Pressable>
      {expanded ? (
        <View
          style={{
            minWidth: 0,
            maxWidth: "100%",
            overflow: "hidden",
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 7,
            backgroundColor: theme.colors.surface0,
            padding: 10,
            gap: 10,
          }}
        >
          <Tabs
            theme={theme}
            items={pickerTabs}
            value={tab}
            onChange={(next) => { setTab(next); setSearch(""); }}
          />
          <Field
            theme={theme}
            value={search}
            onChange={setSearch}
            placeholder={tab === "workspace" ? "搜索工作区名称或路径" : "搜索 Project 名称或路径"}
          />
          <ScrollView
            testID="upstream-workspace-picker-list"
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            style={{ minWidth: 0, maxHeight: Math.min(280, Math.max(96, height * 0.35)), flexGrow: 0 }}
            contentContainerStyle={{ gap: 4 }}
          >
            {tab === "workspace" && !query ? (
              <ChoiceRow
                theme={theme}
                choice={{ id: "", name: "暂不选择工作区", directory: "" }}
                selected={!value}
                disabled={creating}
                onPress={() => { onChange(""); setExpanded(false); }}
              />
            ) : null}
            {choices.map((choice) => (
              <ChoiceRow
                key={choice.id}
                theme={theme}
                choice={choice}
                selected={choice.id === (tab === "workspace" ? value : selectedProject?.id)}
                disabled={creating}
                onPress={() => {
                  if (tab === "project") { setProjectId(choice.id); setError(null); }
                  else { onChange(choice.id); setExpanded(false); setSearch(""); }
                }}
              />
            ))}
            {!choices.length ? (
              <Body theme={theme} muted>
                {loading ? "正在读取…" : query ? "没有匹配结果" : tab === "workspace" ? "还没有工作区，可从 Project 新建。" : "还没有 Project，请先在 Paseo 中添加项目。"}
              </Body>
            ) : null}
          </ScrollView>
          {tab === "workspace" ? (
            <Button theme={theme} label="刷新工作区" busy={refreshing} onPress={onRefresh} />
          ) : null}
          {tab === "project" ? (
            <View style={{ minWidth: 0, gap: 8 }}>
              <Body theme={theme} muted>在所选 Project 的现有目录中新建 Workspace，使用当前分支，不创建新分支。</Body>
              {selectedProject ? (
                <View style={{ minWidth: 0, gap: 3 }}>
                  <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 13 }}>
                    已选 Project：{selectedProject.name}
                  </Text>
                  <Text numberOfLines={2} ellipsizeMode="middle" style={{ minWidth: 0, color: theme.colors.foregroundMuted, fontSize: 12 }}>
                    {selectedProject.directory}
                  </Text>
                </View>
              ) : null}
              <Button
                theme={theme}
                label={creating ? "正在创建…" : creationError ? "重试同一次创建" : previous ? "继续上次创建" : "新建 Workspace"}
                busy={creating}
                disabled={!selectedProject}
                onPress={() => void createWorkspace()}
              />
              {creationError ? (
                <View style={{ gap: 4 }}>
                  <ErrorText theme={theme} error={creationError} />
                  <Body theme={theme} muted>创建结果未确认，请先查看已有 Workspace。重试会沿用同一次请求；另选 Project 不会取消这次请求。</Body>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ChoiceRow({
  theme, choice, selected, disabled, onPress,
}: Themed & {
  choice: WorkspaceChoice;
  selected: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${choice.name}${choice.directory ? `，${choice.directory}` : ""}`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: 0,
        maxWidth: "100%",
        padding: 10,
        gap: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : "transparent",
        backgroundColor: selected || pressed ? theme.colors.surface2 : theme.colors.surface0,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text numberOfLines={1} style={{ minWidth: 0, fontSize: 13.5, color: theme.colors.foreground }}>{choice.name}</Text>
      {choice.directory ? (
        <Text numberOfLines={2} ellipsizeMode="middle" style={{ minWidth: 0, fontSize: 12, color: theme.colors.foregroundMuted }}>{choice.directory}</Text>
      ) : null}
    </Pressable>
  );
}

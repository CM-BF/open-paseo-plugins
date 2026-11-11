import { useState, type ReactNode } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { Anchor, Board } from "../shared/contracts";
import type { SelectionMode } from "../shared/frame-contract";
import { BoardTitle } from "./board-title";
import { UpdateNavigation, type useUpdateNavigation } from "./update-navigation";
import { ToolbarPopover } from "./toolbar-popover";
import { Copy, useColors } from "./ui";

type Menu = "tools" | "reference" | "shortcuts" | "more" | null;
export interface BoardToolbarProps {
  board: Board; onAccepted(board: Board): void; onRefresh(): Promise<unknown>; onBack(): void;
  selectionMode: SelectionMode; onSelectionModeChange(mode: SelectionMode): void; canSelect: boolean;
  anchor?: Anchor; selectedText: string; onClearReference(): void;
  updateNavigation: ReturnType<typeof useUpdateNavigation>;
  onOpenDrawer(drawer: "decisions" | "threads" | "history"): void; onCompose(): void;
  draftCount?: number; draftIssue?: boolean; onOpenDrafts?(): void;
  onPublish?(): void;
  /** Share links of this Board: a dot on 更多 when one has unpublished authored changes. */
  share?: { attention: boolean; detail?: string; available: boolean }; onUpdateShare?(): void;
  /** Live public data for this Board: a dot on 更多 when the owner has to act. */
  live?: { attention: boolean; detail?: string }; onLiveData?(): void;
  onInbox?(): void;
  onSources?(): void; sourceCount?: number;
}
const modes = [["off", "交互", "MousePointer2"], ["component", "选组件", "Component"], ["text", "选文字", "TextSelect"], ["region", "框选", "Scan"], ["point", "指定位置", "MapPin"]] as const;
const modeDescriptions: Record<SelectionMode, string> = {
  off: "操作画布；右键打开消息输入。", component: "选择组件后，直接拖动、右键引用或双击文字改字。",
  text: "拖选文字，在旁边发消息。", region: "拖出一个区域，引用图片、图表或空白。", point: "点击需要交流的位置。",
};
function ToolbarButton({ label, icon, text, active, onPress, testID, primary, badge }: { label: string; icon: string; text?: string; active?: boolean; onPress(): void; testID?: string; primary?: boolean; badge?: string }) {
  const c = useColors();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }} onPress={onPress} style={({ pressed }) => ({ position: "relative", height: 32, minWidth: 32, flexShrink: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: text ? 8 : 6, borderRadius: 6, borderWidth: 0, backgroundColor: primary ? c.accent : pressed || active ? c.surface2 : "transparent" })}>
    <Icon name={icon} size={16} color={primary ? c.accentForeground : c.foregroundMuted} />
    {text ? <Text numberOfLines={1} style={{ color: primary ? c.accentForeground : c.foreground, fontSize: 12 }}>{text}</Text> : null}
    {badge ? <View testID={badge} style={{ pointerEvents: "none", position: "absolute", top: 5, right: 5, width: 7, height: 7, borderRadius: 4, backgroundColor: c.accent, borderWidth: 1, borderColor: c.surface0 }} /> : null}
  </Pressable>;
}
function MenuAction({ label, icon, onPress, selected, detail, testID }: { label: string; icon: string; onPress(): void; selected?: boolean; detail?: string; testID?: string }) {
  const c = useColors();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 9, padding: 9, borderRadius: 6, backgroundColor: pressed || selected ? c.surface2 : "transparent" })}>
    <Icon name={icon} size={16} color={selected ? c.accent : c.foregroundMuted} /><View style={{ flex: 1, minWidth: 0, gap: 3 }}><Text style={{ color: c.foreground, fontSize: 12 }}>{label}</Text>{detail ? <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{detail}</Text> : null}</View>
  </Pressable>;
}
function Shortcut({ keys, children }: { keys: string; children: ReactNode }) {
  const c = useColors();
  return <View style={{ gap: 3, paddingVertical: 3 }}><Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>{keys}</Text><Copy small muted>{children}</Copy></View>;
}
export function BoardToolbar(props: BoardToolbarProps) {
  const c = useColors(), [width, setWidth] = useState(900), [menu, setMenu] = useState<Menu>(null);
  const compact = width < 820, narrow = width < 480;
  const current = modes.find(([mode]) => mode === props.selectionMode) ?? modes[0];
  const open = (next: Exclude<Menu, null>) => setMenu(value => value === next ? null : next);
  const run = (action: () => void) => { setMenu(null); action(); };
  const drafts = !!props.draftCount || !!props.draftIssue;
  const title = menu === "tools" ? "选择工具" : menu === "reference" ? "当前引用" : menu === "shortcuts" ? "快捷键" : "更多";
  return <View testID="board-toolbar" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ height: 48, flexShrink: 0, flexDirection: "row", flexWrap: "nowrap", alignItems: "center", gap: 4, paddingHorizontal: 8, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.surface0, overflow: "visible", zIndex: 40 }}>
    <ToolbarButton label="Boards" icon="PanelsTopLeft" text={compact ? undefined : "Boards"} onPress={props.onBack} />
    <BoardTitle compact menuWidth={Math.min(340, width - 16)} menuOffset={compact ? -36 : 0} board={props.board} onAccepted={props.onAccepted} onRefresh={props.onRefresh} onEditStart={() => setMenu(null)} />
    {props.canSelect ? <ToolbarButton testID="board-tools-open" label="选择工具" icon={current[2]} text={compact ? undefined : `${current[1]} ▾`} active={menu === "tools" || props.selectionMode !== "off"} onPress={() => open("tools")} /> : null}
    {!compact ? <ToolbarButton testID="board-reference-bar" label="当前引用" icon={props.anchor ? "Quote" : "Info"} text={props.anchor ? "已引用" : "引用"} active={menu === "reference"} onPress={() => open("reference")} /> : null}
    {!compact && props.canSelect ? <UpdateNavigation navigation={props.updateNavigation} compact /> : null}
    {drafts && !narrow ? <ToolbarButton testID="board-drafts-open" label={`草稿 ${props.draftCount ?? 0}`} icon={props.draftIssue ? "FileWarning" : "FilePenLine"} text={compact ? undefined : `草稿 ${props.draftCount ?? 0}`} onPress={() => run(() => props.onOpenDrafts?.())} /> : null}
    <ToolbarButton testID="board-shortcuts-open" label="快捷键" icon="Keyboard" active={menu === "shortcuts"} onPress={() => open("shortcuts")} />
    <ToolbarButton testID="board-more-open" label="更多" icon="Ellipsis" active={menu === "more"} badge={props.share?.attention || props.live?.attention ? "board-share-badge" : undefined} onPress={() => open("more")} />
    <ToolbarButton label="发消息" icon="MessageCircle" text={compact ? undefined : "发消息"} primary onPress={() => run(props.onCompose)} />
    <ToolbarPopover open={menu !== null} title={title} onClose={() => setMenu(null)} containerId="board-toolbar" testID="board-toolbar-popup" width={Math.min(340, width - 16)} right={8}>
      {menu === "tools" ? <>{modes.map(([mode, label, icon]) => <MenuAction key={mode} label={label} icon={icon} selected={props.selectionMode === mode} detail={modeDescriptions[mode]} onPress={() => run(() => props.onSelectionModeChange(mode))} />)}<Copy small muted>Esc 返回交互。也可按住 ⌘ / Ctrl + Shift，直接点击组件。</Copy></> : null}
      {menu === "reference" ? <>
        <Copy>{props.anchor ? `已引用 r${props.anchor.boardRevision} · ${props.selectedText}` : modeDescriptions[props.selectionMode]}</Copy>
        {props.anchor?.selector ? <Copy small muted>{props.anchor.selector}</Copy> : null}
        {props.anchor?.image ? <Image accessibilityLabel="当前引用截图" source={{ uri: `data:${props.anchor.image.mimeType};base64,${props.anchor.image.data}` }} resizeMode="contain" style={{ height: 140, width: "100%", backgroundColor: c.surface1, borderRadius: 5 }} /> : null}
        {props.anchor ? <MenuAction label="清除引用" icon="X" onPress={() => run(props.onClearReference)} /> : <Copy small muted>右键或框选后，在对应位置输入消息。</Copy>}
      </> : null}
      {menu === "shortcuts" ? <>
        <Shortcut keys="⌘ / Ctrl + Shift · 移动并点击">按住时预览组件边框，点击选中。</Shortcut>
        <Shortcut keys="选中后：右键 / 直接拖动 / 双击文字">右键引用整个组件；拖动本体移动；双击命中的文字原位改字。</Shortcut>
        <Shortcut keys="拖动中：Tab / Shift + Tab">切换目标容器层级。↑ 放前面，↓ 放后面，← 放入开头，→ 放入末尾。</Shortcut>
        <Shortcut keys="⌘ / Ctrl + C、X、V">复制、剪切组件；选中目标后粘贴。输入框内仍是普通文字快捷键。</Shortcut>
        <Shortcut keys="原位改字：⌘ / Ctrl + Enter">完成编辑并查看保存操作；普通 Enter 换行，Esc 取消。</Shortcut>
        <Shortcut keys="Option / Alt + 拖动">框选区域引用。Esc 退出选择或取消当前拖动。</Shortcut>
        <Shortcut keys="消息：Enter / Shift + Enter">加入待发送 / 换行。讨论追问保存为草稿。</Shortcut>
        <Shortcut keys="消息：⌘ / Ctrl + Enter">当前评论和待发送评论一起发主会话；追问保留原讨论，需先处理待发送评论。</Shortcut>
        <Shortcut keys="消息：Option / Alt + Enter">当前评论发所选 Side；再加 Shift 则新开 Side，不带上待发送评论。新建 Side 时按输入框里的「空白 Side / 带主 agent 记录」。</Shortcut>
        <Shortcut keys="消息：Esc">收起输入并保留草稿，可从工具条的草稿入口继续。</Shortcut>
        <Copy small muted>拖动、剪切、粘贴和改字均先预览，再保存。中文输入法确认候选时不会触发发送。</Copy>
      </> : null}
      {menu === "more" ? <>
        {compact ? <MenuAction label="当前引用" icon="Quote" detail={props.anchor ? props.selectedText : "查看引用与操作提示"} onPress={() => setMenu("reference")} /> : null}
        {drafts && narrow ? <MenuAction testID="board-drafts-open" label={`草稿 ${props.draftCount ?? 0}`} icon="FilePenLine" onPress={() => run(() => props.onOpenDrafts?.())} /> : null}
        {compact && props.canSelect ? <View style={{ paddingVertical: 5 }}><UpdateNavigation navigation={props.updateNavigation} compact /></View> : null}
        <MenuAction label={`决策 ${props.board.decisions.filter(item => !["dismissed", "superseded"].includes(item.status)).length}`} icon="ListChecks" onPress={() => run(() => props.onOpenDrawer("decisions"))} />
        <MenuAction label="讨论" icon="MessagesSquare" onPress={() => run(() => props.onOpenDrawer("threads"))} />
        <MenuAction label="变化" icon="History" onPress={() => run(() => props.onOpenDrawer("history"))} />
        {props.onInbox ? <MenuAction testID="board-inbox-open" label="评论收件箱" icon="Inbox" detail="查看访客评论，控制 agent 读取与内部处理权限" onPress={() => run(() => props.onInbox?.())} /> : null}
        {props.onSources ? <MenuAction testID="board-composition-open" label={`组合来源${props.sourceCount ? ` ${props.sourceCount}` : ""}`} icon="PanelsTopLeft" detail="让 agent 引用、读取并组合其他 Board" onPress={() => run(() => props.onSources?.())} /> : null}
        {props.onPublish ? <MenuAction label="导出与发布" icon="Upload" detail={props.share?.detail} onPress={() => run(() => props.onPublish?.())} /> : null}
        {props.onUpdateShare && props.share?.available ? <MenuAction testID="board-share-update" label="更新分享页" icon="RefreshCw" detail={props.share.attention ? "预览新版本，确认后更新原来的分享链接" : "查看分享链接和状态"} onPress={() => run(() => props.onUpdateShare?.())} /> : null}
        {props.onLiveData ? <MenuAction testID="board-live-open" label="实时公开数据" icon="Radio" detail={props.live?.detail} onPress={() => run(() => props.onLiveData?.())} /> : null}
      </> : null}
    </ToolbarPopover>
  </View>;
}

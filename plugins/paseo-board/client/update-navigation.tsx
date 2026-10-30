import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Board, CanvasUpdate } from "../shared/contracts";
import type { FocusUpdateRequest, UpdatePosition } from "../shared/frame-contract";
import { useColors } from "./ui";

type Place = { key: string; update: CanvasUpdate; targetIndex: number };
type LocationStatus = "idle" | "locating" | "focused" | "unavailable" | "deferred" | "seen-error";
const placesFor = (updates: CanvasUpdate[]): Place[] => updates.flatMap(update => Array.from({ length: Math.max(1, update.targets.length) }, (_, targetIndex) => ({ key: `${update.id}:${targetIndex}`, update, targetIndex })));

/** Navigation is keyed by durable update/target identity, never by a moving list index. */
export function useUpdateNavigation(board: Board | null | undefined, blocked: boolean, markSeen: (id: string) => Promise<void>) {
  const updates = board?.updates ?? [];
  const places = useMemo(() => placesFor(updates), [updates]);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [currentKey, setCurrentKey] = useState<string>();
  const [request, setRequest] = useState<FocusUpdateRequest>();
  const [status, setStatus] = useState<LocationStatus>("idle");
  const [automaticCandidate, setAutomaticCandidate] = useState<string>();
  const latest = useRef({ board, blocked, busy, places, markSeen }); latest.current = { board, blocked, busy, places, markSeen };
  const pending = useRef<FocusUpdateRequest | undefined>(undefined);
  const token = useRef(0);
  const known = useRef<{ initialized: boolean; newest?: string }>({ initialized: false });
  const focused = useRef(new Map<string, Set<number>>());
  const acknowledging = useRef(new Set<string>());

  const show = useCallback((place: Place, automatic: boolean) => {
    const next = { update: place.update, targetIndex: place.targetIndex, token: ++token.current, automatic };
    pending.current = next; setCurrentKey(place.key); setRequest(next); setStatus("locating");
  }, []);
  useEffect(() => {
    if (!board) return;
    const newest = updates.at(-1)?.id;
    if (!known.current.initialized || known.current.newest !== newest) {
      const first = !known.current.initialized;
      known.current = { initialized: true, newest };
      const seen = new Set(board.seenUpdateIds);
      const candidate = first ? [...updates].reverse().find(item => !seen.has(item.id)) : updates.at(-1);
      if (candidate && !seen.has(candidate.id)) setAutomaticCandidate(candidate.id);
    }
    const live = new Set(updates.map(item => item.id));
    for (const id of focused.current.keys()) if (!live.has(id)) focused.current.delete(id);
  }, [board, updates]);
  useEffect(() => {
    if (!follow || blocked || busy || !automaticCandidate) return;
    const place = places.find(item => item.update.id === automaticCandidate);
    setAutomaticCandidate(undefined);
    if (place) show(place, true);
  }, [follow, blocked, busy, automaticCandidate, places, show]);
  // A composer or selection opened after dispatch also invalidates an in-flight automatic jump.
  useEffect(() => {
    if (!blocked || !pending.current?.automatic) return;
    setAutomaticCandidate(pending.current.update.id); pending.current = undefined; setRequest(undefined); setStatus("deferred");
  }, [blocked]);

  const onActivity = useCallback((active: boolean) => {
    setBusy(active);
    if (active && pending.current?.automatic) {
      setAutomaticCandidate(pending.current.update.id); pending.current = undefined; setRequest(undefined); setStatus("deferred");
    }
  }, []);
  const onPosition = useCallback((result: UpdatePosition) => {
    const expected = pending.current;
    const current = latest.current;
    if (!expected || result.id !== expected.update.id || result.token !== expected.token || result.targetIndex !== (expected.targetIndex ?? 0) || result.documentVersion !== expected.update.documentVersion || result.status === "focused" && current.board?.canvas.documentVersion !== result.documentVersion) return;
    if (expected.automatic && (current.blocked || current.busy)) return;
    pending.current = undefined;
    setStatus(result.status);
    if (result.status === "deferred") {
      setBusy(true);
      if (expected.automatic) setAutomaticCandidate(result.id);
      return;
    }
    if (result.status !== "focused") return;
    const visited = focused.current.get(result.id) ?? new Set<number>();
    visited.add(result.targetIndex); focused.current.set(result.id, visited);
    const saved = current.board?.updates.find(item => item.id === result.id);
    if (!saved || visited.size < Math.max(1, saved.targets.length) || current.board?.seenUpdateIds.includes(result.id) || acknowledging.current.has(result.id)) return;
    acknowledging.current.add(result.id);
    void current.markSeen(result.id).catch(() => { if (latest.current.board?.id === current.board?.id) setStatus("seen-error"); }).finally(() => acknowledging.current.delete(result.id));
  }, []);
  const index = places.findIndex(item => item.key === currentKey);
  const move = (direction: number) => {
    if (blocked || !places.length) return;
    setFollow(false); setAutomaticCandidate(undefined);
    const next = index < 0 ? places.length - 1 : (index + direction + places.length) % places.length;
    show(places[next], false);
  };
  const toggleFollow = () => {
    if (blocked) return;
    if (follow) { setFollow(false); return; }
    setFollow(true);
    const seen = new Set(board?.seenUpdateIds);
    const candidate = [...updates].reverse().find(item => !seen.has(item.id)) ?? updates.at(-1);
    if (candidate) setAutomaticCandidate(candidate.id);
  };
  return { request, onPosition, onActivity, move, toggleFollow, follow, busy, index, total: places.length, status, unread: updates.filter(item => !board?.seenUpdateIds.includes(item.id)).length, blocked };
}

export function UpdateNavigation({ navigation }: { navigation: ReturnType<typeof useUpdateNavigation> }) {
  const c = useColors();
  const { move, follow, busy, index, total, status, unread, blocked, toggleFollow } = navigation;
  const button = (label: string, text: string, onPress: () => void, disabled: boolean) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ disabled }} onPress={onPress} style={{ paddingHorizontal: 7, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 5, opacity: disabled ? 0.4 : 1 }}><Text style={{ color: c.foreground, fontSize: 12 }}>{text}</Text></Pressable>;
  const note = status === "unavailable" ? "位置不可用" : status === "seen-error" ? "已看未保存" : status === "deferred" || busy || blocked ? "暂缓" : "";
  return <View testID="board-update-navigation" accessibilityLabel="画布更新定位" style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 }}>
    {button("上一处更新", "‹", () => move(-1), blocked || !total)}
    <Text testID="board-update-position" numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>{`更新 ${index < 0 ? 0 : index + 1}/${total}`}{unread ? ` · ${unread} 未看` : ""}{note ? ` · ${note}` : ""}</Text>
    {button("下一处更新", "›", () => move(1), blocked || !total)}
    {button(follow ? "暂停跟随更新" : "继续跟随更新", follow ? "跟随 ●" : "跟随 ○", toggleFollow, blocked)}
  </View>;
}

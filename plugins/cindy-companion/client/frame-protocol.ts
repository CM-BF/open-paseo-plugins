export const FRAME_CHANNEL = "cindy-companion";
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export type FrameRequest = {
  channel: typeof FRAME_CHANNEL;
  type: "request";
  id: string;
  op: string;
  args?: unknown;
};

export type FrameEvent = FrameRequest | {
  channel: typeof FRAME_CHANNEL;
  type: "ready" | "close" | "changed" | "profile-changed";
} | {
  channel: typeof FRAME_CHANNEL;
  type: "navigate-agent";
  agentId: string;
};

/** Validate before dispatching into the selected host's authenticated RPC. */
export function readFrameEvent(value: unknown): FrameEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.channel !== FRAME_CHANNEL) return null;
  if (["ready", "close", "changed", "profile-changed"].includes(String(message.type))) return value as FrameEvent;
  if (message.type === "navigate-agent") {
    return typeof message.agentId === "string" && message.agentId.length > 0 && message.agentId.length <= 128
      ? value as FrameEvent : null;
  }
  if (message.type !== "request" || typeof message.id !== "string" || message.id.length === 0 || message.id.length > 128 ||
    typeof message.op !== "string" || message.op.length === 0 || message.op.length > 128) return null;
  try {
    if (JSON.stringify(message).length > MAX_MESSAGE_BYTES) return null;
  } catch { return null; }
  return value as FrameRequest;
}

export function appearanceFromBackground(color: string): "dark" | "light" {
  const match = /^#([a-f\d]{6}|[a-f\d]{3})$/i.exec(color);
  if (!match) return "dark";
  const hex = match[1].length === 3 ? [...match[1]].map(char => char + char).join("") : match[1];
  const red = parseInt(hex.slice(0, 2), 16), green = parseInt(hex.slice(2, 4), 16), blue = parseInt(hex.slice(4, 6), 16);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 140 ? "dark" : "light";
}

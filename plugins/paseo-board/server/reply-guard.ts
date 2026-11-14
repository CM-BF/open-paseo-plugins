/**
 * Server-side refusal of public replies that look like they carry secrets (DESIGN §11.3).
 * Runs before the ledger write and again before every POST. Pattern based: it can miss
 * paraphrased secrets, and only the human panel may override it after a confirm.
 */
export interface ReplyGuardContext {
  /** Export tokens of every connection of this Board (current and pending previous). */
  tokens: readonly string[];
  /** Registered export endpoint URLs of this Board. */
  endpoints: readonly string[];
  env?: NodeJS.ProcessEnv;
}

const SECRET_ENV_KEY = /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
const PROVIDER_KEY = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/;
const LONG_HEX = /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/;
const ENCODED_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const LOCAL_PATH = /(?:^|[\s"'(（「])(?:\/Users\/|\/home\/|\/root\/|~\/\.|[A-Za-z]:\\Users\\)/;

/**
 * The endpoint's host name as a whole host, never inside a word or a longer host name. Single-label names
 * (`api`, `board`, `localhost`) are ordinary words, so only dotted names and IP literals are matched; the full
 * endpoint URL still matches for every host.
 */
function hostMentioned(lower: string, host: string): boolean {
  if (!host || !host.includes(".") && !host.includes(":")) return false;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = host.includes(":") ? "(?<![A-Za-z0-9.:-])" : "(?<![A-Za-z0-9.-])";
  return new RegExp(`${before}${escaped}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, "i").test(lower);
}

/** Returns the Chinese reason (`令牌`, `后端地址`, …) of the first matching rule, or null. */
export function replyGuardReason(text: string, context: ReplyGuardContext): string | null {
  const env = context.env ?? process.env;
  const secrets = [
    ...context.tokens.filter(token => token.length >= 8),
    ...Object.entries(env).filter(([key, value]) => SECRET_ENV_KEY.test(key) && typeof value === "string" && value.length >= 16).map(([, value]) => value as string),
  ];
  if (text.includes("PASEO_BOARD_BINDING") || secrets.some(secret => text.includes(secret))) return "令牌";
  const lower = text.toLowerCase();
  for (const endpoint of context.endpoints) {
    const url = endpoint.replace(/\/+$/, "").toLowerCase();
    if (url && lower.includes(url)) return "后端地址";
    let host = "";
    try { host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { /* registered endpoints are valid URLs */ }
    if (hostMentioned(lower, host)) return "后端地址";
  }
  if (text.includes("-----BEGIN")) return "密钥";
  if (JWT.test(text)) return "令牌";
  if (PROVIDER_KEY.test(text)) return "密钥";
  if (LONG_HEX.test(text)) return "长串十六进制";
  for (const match of text.matchAll(ENCODED_RUN)) if (/[A-Z]/.test(match[0]) && /[a-z]/.test(match[0]) && /\d/.test(match[0])) return "长串编码";
  if (LOCAL_PATH.test(text)) return "本机路径";
  return null;
}
export const replyGuardMessage = (reason: string) => `回复看起来包含私密信息（${reason}），未发送。`;

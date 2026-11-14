import { AppKeySchema, COMMENTS_HEALTH_TIMEOUT_MS, CommentsProbeInputSchema, CommentsProbeResultSchema, commentsOriginProblem, commentsProbeRefusal, type CommentsProbeResult, type VisitorCommentsRelease } from "../shared/release-contracts";

/** The host's own network; tests inject a fake. */
export type CommentsFetcher = (url: string, init: RequestInit) => Promise<Response>;
const BODY_LIMIT = 65_536;

async function readLimited(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > BODY_LIMIT) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const failure = (error: unknown) => {
  const name = error instanceof Error ? error.name : "", message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  if (name === "TimeoutError" || name === "AbortError") return `${COMMENTS_HEALTH_TIMEOUT_MS / 1000} 秒内没有响应`;
  if (/redirect/i.test(message) || /redirect/i.test(cause)) return "后端返回了重定向，请填写最终地址";
  return `无法连接（${(cause || message).slice(0, 200)}）`;
};

/**
 * Reads the backend's public health with no Origin, then once per page origin with that Origin to find
 * missing CORS entries (as the live-data probe does). Only a 200 health body counts as reachable.
 */
export async function probeComments(raw: unknown, fetcher: CommentsFetcher = fetch): Promise<CommentsProbeResult> {
  const { apiBase, pageOrigins } = CommentsProbeInputSchema.parse(raw), url = `${apiBase}/_board/health`;
  const get = async (origin?: string) => {
    try {
      const response = await fetcher(url, { headers: { Accept: "application/json", ...(origin ? { Origin: origin } : {}) }, redirect: "error", signal: AbortSignal.timeout(COMMENTS_HEALTH_TIMEOUT_MS) as RequestInit["signal"] });
      return { status: response.status, allowOrigin: response.headers.get("access-control-allow-origin"), text: await readLimited(response), error: undefined };
    } catch (error) { return { status: 0, allowOrigin: null, text: null, error: failure(error) }; }
  };
  const result: CommentsProbeResult = { reachable: false, httpStatus: null, appId: null, appKey: null, deploymentId: null, comments: "unknown", publicThreads: "unknown", clientIp: "unknown", originProblems: [], error: null };
  const health = await get();
  if (health.error !== undefined) return { ...result, error: health.error };
  result.httpStatus = health.status;
  if (health.status !== 200) return { ...result, error: `健康检查返回 HTTP ${health.status}` };
  let body: Record<string, unknown> | null = null;
  try { const parsed: unknown = health.text === null ? null : JSON.parse(health.text); body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { body = null; }
  if (!body || typeof body.id !== "string" || typeof body.deploymentId !== "string") return { ...result, error: "返回的不是 paseo-board-app 后端的健康检查" };
  result.reachable = true;
  result.appId = body.id.slice(0, 200); result.deploymentId = body.deploymentId.slice(0, 200);
  result.appKey = AppKeySchema.safeParse(body.appKey).success ? body.appKey as string : null;
  result.comments = body.comments === 2 ? "threads" : body.comments === 0 ? "disabled" : body.comments === undefined ? "basic" : "unknown";
  if (result.comments === "unknown") result.error = "后端报告了无法识别的评论版本";
  result.publicThreads = body.publicThreads === 1 ? "available" : body.publicThreads === 0 ? "off" : body.publicThreads === undefined ? "unsupported" : "unknown";
  result.clientIp = body.clientIp === "socket" || body.clientIp === "forwarded" || body.clientIp === "proxied-unconfigured" ? body.clientIp : "unknown";
  for (const pageOrigin of pageOrigins) {
    const seen = await get(pageOrigin);
    if (seen.error !== undefined || seen.status === 403 || seen.allowOrigin !== pageOrigin) result.originProblems.push(commentsOriginProblem(pageOrigin));
  }
  return CommentsProbeResultSchema.parse(result);
}

/** Release creation needs the thread runtime of exactly the app the human checked (and public threads for 公开); throws the refusal otherwise. */
export async function requireCommentsBackend(comments: VisitorCommentsRelease, fetcher: CommentsFetcher = fetch): Promise<CommentsProbeResult> {
  const result = await probeComments({ apiBase: comments.apiBase }, fetcher), refusal = commentsProbeRefusal(result, comments.appKey, comments.visibility);
  if (refusal) throw new Error(refusal);
  return result;
}

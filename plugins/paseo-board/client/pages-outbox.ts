import { PagesPrepareSchema, type PagesPrepareInput } from "../shared/release-contracts";
import { browserDraftStorage } from "./draft-storage-web";
import type { DraftStorage } from "./draft-store";

/** Missing hosts belong to the original github.com-only publication format. */
export const pagesGitHubHost = (request: { githubHost?: string }) => request.githubHost ?? "github.com";
export const samePagesTarget = (left: PagesPrepareInput, right: Omit<PagesPrepareInput, "eventId">) =>
  left.releaseId === right.releaseId && left.artifactHash === right.artifactHash &&
  pagesGitHubHost(left) === pagesGitHubHost(right) && left.account === right.account &&
  left.repository === right.repository && left.createRepository === right.createRepository;
export const samePagesRequest = (left: PagesPrepareInput, right: PagesPrepareInput) =>
  left.eventId === right.eventId && samePagesTarget(left, right);

/** Small immutable request journal. Credentials and public page contents never enter it. */
export function createPagesOutbox(hostId: string, boardId: string, storage: DraftStorage | null = browserDraftStorage()) {
  const prefix = `@paseo:board-pages:v1:${encodeURIComponent(JSON.stringify([hostId, boardId]))}:`;
  const requireStorage = () => { if (!storage) throw new Error("此客户端无法保留发布重试记录，请从桌面浏览器发布。"); return storage; };
  const read = (text: string): PagesPrepareInput => {
    const value = JSON.parse(text);
    // Legacy records requested PR preparation only. Reading them never grants
    // automatic merge permission; save() is called by an explicit Publish click.
    if (value?.action !== undefined && value.action !== "publish") throw new Error("本机发布记录的操作无法识别；原记录已保留。");
    return PagesPrepareSchema.parse(value?.action === "publish" ? value.request : value);
  };
  return {
    list(): PagesPrepareInput[] {
      const db = requireStorage(), result: PagesPrepareInput[] = [];
      for (let index = 0; index < db.length; index++) {
        const key = db.key(index); if (!key?.startsWith(prefix)) continue;
        const text = db.getItem(key); if (text === null) continue;
        const request = read(text);
        if (key !== prefix + request.eventId) throw new Error("本机发布记录标识不匹配；原记录已保留。");
        result.push(request);
      }
      return result;
    },
    save(raw: PagesPrepareInput): PagesPrepareInput {
      const db = requireStorage();
      let request = PagesPrepareSchema.parse(raw);
      const key = prefix + request.eventId;
      const existing = db.getItem(key);
      if (existing) {
        const original = read(existing);
        if (!samePagesRequest(original, request)) throw new Error("同一次发布请求的版本或目标已改变。");
        // Do not rewrite an old wire request just to spell out its default host.
        request = original;
      }
      db.setItem(key, JSON.stringify({ action: "publish", request }));
      return request;
    },
    remove(eventId: string): void { requireStorage().removeItem(prefix + eventId); },
  };
}

import { PagesPrepareSchema, type PagesPrepareInput } from "../shared/release-contracts";
import { browserDraftStorage } from "./draft-storage-web";
import type { DraftStorage } from "./draft-store";

/** Small immutable request journal. Credentials and public page contents never enter it. */
export function createPagesOutbox(hostId: string, boardId: string, storage: DraftStorage | null = browserDraftStorage()) {
  const prefix = `@paseo:board-pages:v1:${encodeURIComponent(JSON.stringify([hostId, boardId]))}:`;
  const requireStorage = () => { if (!storage) throw new Error("此客户端无法保留发布重试记录，请从桌面浏览器发布。"); return storage; };
  return {
    list(): PagesPrepareInput[] {
      const db = requireStorage(), result: PagesPrepareInput[] = [];
      for (let index = 0; index < db.length; index++) {
        const key = db.key(index); if (!key?.startsWith(prefix)) continue;
        const text = db.getItem(key); if (text === null) continue;
        const request = PagesPrepareSchema.parse(JSON.parse(text));
        if (key !== prefix + request.eventId) throw new Error("本机发布记录标识不匹配；原记录已保留。");
        result.push(request);
      }
      return result;
    },
    save(raw: PagesPrepareInput): PagesPrepareInput {
      const db = requireStorage(), request = PagesPrepareSchema.parse(raw), key = prefix + request.eventId;
      const existing = db.getItem(key);
      if (existing && JSON.stringify(PagesPrepareSchema.parse(JSON.parse(existing))) !== JSON.stringify(request)) throw new Error("同一次发布请求的版本或目标已改变。");
      db.setItem(key, JSON.stringify(request));
      return request;
    },
    remove(eventId: string): void { requireStorage().removeItem(prefix + eventId); },
  };
}

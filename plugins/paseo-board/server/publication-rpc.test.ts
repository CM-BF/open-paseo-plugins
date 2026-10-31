import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, expect, it, vi } from "vitest";
import type { ReleaseManifest, PagesJob } from "../shared/release-contracts";
import { BoardStore } from "./store";
import { ReleaseRepository } from "./static-release";
import { registerPublicationRpc, type PagesGateway } from "./publication-rpc";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "board-publication-rpc-")); directories.push(root);
  const store = new BoardStore(join(root, "boards"));
  const board = await store.create({ id: "work", title: "Work", ownerAgentId: "owner", html: "<p>Published text</p>", data: { secret: "PRIVATE_DATA" } });
  const releases = new ReleaseRepository(join(root, "releases"));
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const pages: PagesGateway = {
    accounts: vi.fn(async () => []), repositories: vi.fn(async () => []),
    prepare: vi.fn(async input => ({ ...input, jobId: "job", branch: "publication", status: "pr-open" })),
    merge: vi.fn(async () => { throw new Error("Unexpected merge"); }),
    refresh: vi.fn(async () => { throw new Error("Unexpected refresh"); }),
    list: vi.fn(async () => []), read: vi.fn(async () => { throw new Error("Missing job"); }),
  };
  let sourceAvailable = true;
  const requireBoard = vi.fn(async (id: string) => {
    const current = sourceAvailable ? await store.read(id) : null;
    if (!current) throw new Error("Missing source Board"); return current;
  });
  const ready = vi.fn(async () => {});
  registerPublicationRpc({ handle(contract: { name: string }, handler: (input: unknown) => Promise<unknown>) { handlers.set(contract.name, handler); } } as PluginServerContext,
    { ready, requireBoard, releases, pages });
  const invoke = (name: string, input: unknown) => {
    const handler = handlers.get(name); if (!handler) throw new Error("Missing RPC " + name); return handler(input);
  };
  const create = () => invoke("board.release.create", { boardId: board.id, expectedCanvasBase: { revision: 1, documentVersion: 1 }, publicData: { label: "Public" } }) as Promise<ReleaseManifest>;
  return { board, store, pages, releases, invoke, create, ready, requireBoard, removeSource: () => { sourceAvailable = false; } };
}

it("reads the current Board and refuses stale export through the registered host handler", async () => {
  const f = await fixture();
  await f.store.publish({ boardId: "work", expectedRevision: 1, canvasBase: { revision: 1, documentVersion: 1 }, eventId: "edit", replaceDocument: true, html: "<p>New work</p>" });
  await expect(f.create()).rejects.toThrow("Canvas changed");
  expect(await f.releases.list()).toEqual([]); expect(f.pages.prepare).not.toHaveBeenCalled();
});

it("keeps a frozen export usable after its working source becomes unavailable", async () => {
  const f = await fixture(), manifest = await f.create(); f.removeSource();
  const preview = await f.invoke("board.release.preview", { releaseId: manifest.releaseId });
  expect(JSON.stringify(preview)).toContain("Published text"); expect(JSON.stringify(preview)).not.toContain("PRIVATE_DATA");
  const download = await f.invoke("board.release.download", { releaseId: manifest.releaseId }) as { zipBase64: string };
  expect(Buffer.from(download.zipBase64, "base64").subarray(0, 2).toString()).toBe("PK");
  const request = { eventId: "publish", releaseId: manifest.releaseId, artifactHash: manifest.artifactHash, account: "fixture", repository: "fixture/site" };
  const job = await f.invoke("board.pages.prepare", request) as PagesJob;
  expect(job.eventId).toBe(request.eventId); expect(f.pages.prepare).toHaveBeenCalledExactlyOnceWith(request);
  expect(f.requireBoard).toHaveBeenCalledTimes(1);
});

it("rejects missing release evidence before any GitHub operation, including recovered jobs", async () => {
  const f = await fixture(), manifest = await f.create();
  const missing = "release-" + "0".repeat(64);
  const request = { eventId: "publish", releaseId: missing, artifactHash: manifest.artifactHash, account: "fixture", repository: "fixture/site" };
  await expect(f.invoke("board.pages.prepare", request)).rejects.toThrow();
  vi.mocked(f.pages.read).mockResolvedValue({ ...request, jobId: "job", branch: "publication", status: "pr-open" });
  await expect(f.invoke("board.pages.merge", { jobId: "job", expectedHead: "a".repeat(40) })).rejects.toThrow();
  await expect(f.invoke("board.pages.refresh", { jobId: "job" })).rejects.toThrow();
  expect(f.pages.prepare).not.toHaveBeenCalled(); expect(f.pages.merge).not.toHaveBeenCalled(); expect(f.pages.refresh).not.toHaveBeenCalled();
});

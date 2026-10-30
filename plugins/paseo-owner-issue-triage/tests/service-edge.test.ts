import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, type IssueSnapshot, type Run, type TriageResult } from "../shared/types";
import { GitHubClient, GitHubError, type RawIssue } from "../server/github";
import { TriageService } from "../server/service";
import { Store } from "../server/store";
import type { WorkerInspection, WorkerPort } from "../server/worker";

const stores: Store[] = [];
const directories: string[] = [];
const REPO = "owner/repo";
const OWNER = 42;
const NOW = Date.parse("2026-10-29T12:00:00Z");
const result: TriageResult = { category: "docs", priority: "P3", plugins: [], summary: "Fixture analysis", nextSteps: [], confidence: "high" };
const fingerprint = (body: string) => createHash("sha256").update(body).digest("hex");

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  let now = NOW;
  const directory = mkdtempSync(join(tmpdir(), "plugin-test-triage-edge-"));
  directories.push(directory);
  const store = new Store(directory, now);
  stores.push(store);
  const rows = new Map<number, RawIssue>();
  const snapshots = new Map<number, IssueSnapshot>();
  const github = {
    identity: vi.fn(async () => ({ id: OWNER, login: "owner" })),
    listIssues: vi.fn(async () => [...rows.values()]),
    getIssue: vi.fn(async (_repo: string, number: number) => {
      const row = rows.get(number);
      if (!row) throw new GitHubError("Fixture issue no longer exists", { status: 404 });
      return structuredClone(row);
    }),
    snapshot: vi.fn(async (_repo: string, row: RawIssue, ownerId: number) => {
      if (row.user?.id !== ownerId || Object.hasOwn(row, "pull_request")) return null;
      return structuredClone(snapshots.get(row.number)!);
    }),
  };
  const worker = {
    validate: vi.fn(async () => {}), start: vi.fn(async (_run: Run) => {}),
    inspect: vi.fn(async (): Promise<WorkerInspection> => ({ status: "running" })),
    stop: vi.fn(async () => {}), archive: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    catalog: vi.fn(async () => ({ providers: [] })),
  };
  const service = new TriageService(store, github as unknown as GitHubClient, worker as WorkerPort, () => now);
  function add(number = 1, body = "revision-a") {
    const time = new Date(now).toISOString();
    const raw: RawIssue = { number, title: "Fixture", body, html_url: `https://github.com/${REPO}/issues/${number}`, user: { id: OWNER }, created_at: time, updated_at: time, state: "open" };
    rows.set(number, raw);
    snapshots.set(number, { repo: REPO, number, title: raw.title, body, url: raw.html_url, authorId: OWNER, createdAt: time, updatedAt: time, state: "open", comments: [], fingerprint: fingerprint(body) });
  }
  function edit(body: string) {
    rows.get(1)!.body = body;
    snapshots.get(1)!.body = body;
    snapshots.get(1)!.fingerprint = fingerprint(body);
  }
  return {
    directory, store, service, github, worker, rows, snapshots, add, edit,
    advance(ms: number) { now += ms; },
    enable: () => service.configure(ConfigSchema.parse({ enabled: true, repos: [REPO], pollSeconds: 60 })),
  };
}

describe("service failure boundaries", () => {
  it("does not first-deliver a reserved retry after intake is paused", async () => {
    const f = fixture();
    await f.enable(); f.add();
    f.worker.start.mockRejectedValueOnce(Object.assign(new Error("Fixture daemon offline"), { name: "WorkerError", retryable: true }));
    await f.service.tick();
    expect(f.store.state.items[0]!.run?.phase).toBe("reserved");
    await f.service.configure({ ...f.store.state.config, enabled: false });
    f.advance(61_000);
    await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(1);
  });

  it("allows pausing an existing installation when GitHub identity is unavailable", async () => {
    const f = fixture();
    await f.enable();
    f.github.identity.mockRejectedValue(new GitHubError("Fixture GitHub unavailable", { status: 429, retryAt: NOW + 3_600_000 }));
    await expect(f.service.configure({ ...f.store.state.config, enabled: false })).resolves.toMatchObject({ config: { enabled: false } });
    expect(f.store.state.config.enabled).toBe(false);
  });

  it("does not resume reserved dispatch after the pinned account has changed", async () => {
    const f = fixture();
    await f.enable(); f.add();
    f.worker.start.mockRejectedValueOnce(Object.assign(new Error("Fixture daemon offline"), { name: "WorkerError", retryable: true }));
    await f.service.tick();
    f.github.identity.mockResolvedValue({ id: 77, login: "other-account" });
    f.advance(61_000);
    await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(1);
    expect(f.store.state.owner?.id).toBe(OWNER);
  });

  it("honors rate limits encountered while reconciling a reserved delivery", async () => {
    const f = fixture();
    await f.enable(); f.add();
    f.worker.start.mockRejectedValueOnce(Object.assign(new Error("Fixture daemon offline"), { name: "WorkerError", retryable: true }));
    await f.service.tick();
    const reset = NOW + 3_600_000;
    f.github.identity.mockRejectedValue(new GitHubError("Fixture GitHub rate limited", { status: 429, retryAt: reset }));
    f.advance(31_000);
    await f.service.tick();
    expect(f.store.state.scan.nextAt).toBeGreaterThanOrEqual(reset);
    const calls = f.github.identity.mock.calls.length;
    f.advance(10_000); await f.service.tick();
    expect(f.github.identity).toHaveBeenCalledTimes(calls);
    expect(f.worker.start).toHaveBeenCalledTimes(1);
  });

  it("isolates a deleted tracked issue instead of blocking every new issue", async () => {
    const f = fixture();
    await f.enable(); f.add();
    await f.service.scanNow();
    f.rows.delete(1); f.add(2);
    await f.service.scanNow();
    expect(f.store.state.scan.error).toBeNull();
    expect(f.store.state.items.find((item) => item.snapshot.number === 2)?.status).toBe("queued");
    await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(1);
    expect(f.worker.start.mock.calls[0]![0].snapshot.number).toBe(2);
  });

  it("can manually retry an unavailable issue once GitHub access is restored", async () => {
    const f = fixture();
    await f.enable(); f.add(); await f.service.scanNow();
    f.rows.delete(1); await f.service.scanNow();
    expect(f.store.state.items[0]!.status).toBe("failed");
    f.add();
    await f.service.action(`${REPO}#1`, "retry");
    await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(1);
  });

  it("does not first-deliver a reserved retry after the tracked issue closes", async () => {
    const f = fixture();
    await f.enable(); f.add();
    f.worker.start.mockRejectedValueOnce(Object.assign(new Error("Fixture daemon offline"), { name: "WorkerError", retryable: true }));
    await f.service.tick();
    f.rows.get(1)!.state = "closed";
    f.snapshots.get(1)!.state = "closed";
    await f.service.scanNow();
    f.advance(31_000); await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(1);
  });

  it("cannot dispatch an in-memory reservation after its durable write failed", async () => {
    const f = fixture();
    await f.enable(); f.add();
    await f.service.scanNow();
    const originalSave = f.store.save.bind(f.store);
    const token = JSON.parse(readFileSync(join(f.directory, "writer.lock"), "utf8")).token;
    const blockedPath = join(f.directory, `state.json.${token}.tmp`);
    const save = vi.spyOn(f.store, "save").mockImplementation(() => {
      // A directory occupying the temporary file exercises the real Store.save IO failure path.
      if (f.store.state.items.some((item) => item.run)) mkdirSync(blockedPath, { recursive: true });
      originalSave();
    });
    await f.service.tick().catch(() => undefined);
    const saved = JSON.parse(readFileSync(join(f.directory, "state.json"), "utf8"));
    expect(saved.items[0].run).toBeNull();
    rmSync(blockedPath, { recursive: true, force: true });
    save.mockRestore();
    await f.service.tick().catch(() => undefined);
    expect(f.worker.start).not.toHaveBeenCalled();
  });

  it("coalesces a queued edit that reverts to the already completed fingerprint", async () => {
    const f = fixture();
    await f.enable(); f.add();
    await f.service.tick();
    f.worker.inspect.mockResolvedValue({ status: "completed", result });
    await f.service.tick();
    f.edit("revision-b"); await f.service.scanNow();
    f.edit("revision-a"); await f.service.scanNow();
    await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(1);
    expect(f.store.state.items[0]!.status).toBe("completed");
  });

  it("shows a reopened completed issue as completed without dispatching unchanged content", async () => {
    const f = fixture();
    await f.enable(); f.add(); await f.service.tick();
    f.worker.inspect.mockResolvedValue({ status: "completed", result }); await f.service.tick();
    f.rows.get(1)!.state = "closed"; f.snapshots.get(1)!.state = "closed"; await f.service.scanNow();
    expect(f.store.state.items[0]!.status).toBe("closed");
    f.rows.get(1)!.state = "open"; f.snapshots.get(1)!.state = "open"; await f.service.scanNow();
    expect(f.store.state.items[0]!.status).toBe("completed");
    expect(f.worker.start).toHaveBeenCalledTimes(1);
  });
});

describe("durable dedup state validation", () => {
  it("fails closed when valid JSON loses the required issue ledger", async () => {
    const f = fixture();
    await f.enable(); f.add(); await f.service.tick();
    f.store.close();
    const file = join(f.directory, "state.json");
    const corrupted = JSON.parse(readFileSync(file, "utf8"));
    delete corrupted.items;
    const original = JSON.stringify(corrupted);
    writeFileSync(file, original);
    expect(() => {
      const reopened = new Store(f.directory, NOW);
      stores.push(reopened);
    }).toThrow();
    expect(readFileSync(file, "utf8")).toBe(original);
  });
});

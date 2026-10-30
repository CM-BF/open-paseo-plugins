import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, type IssueSnapshot, type Run, type TriageResult } from "../shared/types";
import { GitHubClient, GitHubError, type RawIssue } from "../server/github";
import { TriageService } from "../server/service";
import { Store } from "../server/store";
import type { WorkerPort } from "../server/worker";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const result: TriageResult = { category: "bug", priority: "P2", plugins: ["example"], summary: "A test finding", nextSteps: ["Review the reproduction"], confidence: "medium" };
function fixture() {
  let now = Date.parse("2026-10-29T12:00:00Z");
  const root = mkdtempSync(join(tmpdir(), "plugin-test-owner-triage-")); roots.push(root);
  const store = new Store(root, now); stores.push(store);
  const rows: RawIssue[] = [];
  const snapshots = new Map<number, IssueSnapshot>();
  const github = {
    identity: vi.fn(async () => ({ id: 42, login: "owner" })),
    listIssues: vi.fn(async () => [...rows]),
    getIssue: vi.fn(async (_repo: string, number: number) => rows.find((row) => row.number === number)!),
    snapshot: vi.fn(async (_repo: string, issue: RawIssue, owner: number) => issue.user?.id === owner && !("pull_request" in issue) ? structuredClone(snapshots.get(issue.number)!) : null),
  };
  let outcome: { status: "running" | "completed" | "failed"; result?: TriageResult; error?: string } = { status: "running" };
  const worker = { validate: vi.fn(async () => {}), start: vi.fn(async (_run: Run) => {}), inspect: vi.fn(async () => outcome), stop: vi.fn(async () => {}), archive: vi.fn(async () => {}), dispose: vi.fn(async () => {}), catalog: vi.fn(async () => ({ providers: [{ id: "codex", modes: [], models: [{ id: "gpt-5.4-mini", label: "Mini", thinking: ["low"] }] }] })) };
  const service = new TriageService(store, github as unknown as GitHubClient, worker as WorkerPort, () => now);
  function add(number = 1, body = "revision-1", old = false, authorId = 42, pr = false) {
    const timestamp = new Date(old ? now - 86_400_000 : now).toISOString();
    const raw: RawIssue = { number, title: "Issue", body, html_url: `https://github.com/owner/repo/issues/${number}`, user: { id: authorId }, created_at: timestamp, updated_at: timestamp, state: "open", ...(pr ? { pull_request: {} } : {}) };
    rows.push(raw);
    snapshots.set(number, { repo: "owner/repo", number, title: raw.title, body, url: raw.html_url, authorId, createdAt: timestamp, updatedAt: timestamp, state: "open", comments: [], fingerprint: body });
  }
  return { root, store, service, github, worker, rows, snapshots, add, advance: (ms: number) => { now += ms; }, setOutcome: (value: typeof outcome) => { outcome = value; }, enable: () => service.configure(ConfigSchema.parse({ enabled: true, repos: ["owner/repo"], pollSeconds: 60 })) };
}

describe("durable owner issue queue", () => {
  it("empty scans, other authors, and PRs never wake a model", async () => {
    const f = fixture(); await f.enable(); await f.service.tick();
    f.add(1, "I am owner 42", false, 77); f.add(2, "PR", false, 42, true);
    await f.service.scanNow(); await f.service.tick();
    expect(f.worker.start).not.toHaveBeenCalled(); expect(f.store.state.items).toEqual([]);
  });
  it("discovers history without launching, while new issues dispatch once across concurrent ticks", async () => {
    const f = fixture(); f.add(1, "old", true); await f.enable(); await f.service.tick();
    expect(f.store.state.items[0].status).toBe("discovered");
    f.add(2); await f.service.scanNow(); await Promise.all([f.service.tick(), f.service.tick(), f.service.scanNow()]);
    expect(f.worker.start).toHaveBeenCalledTimes(1);
    expect(f.store.state.items.find((item) => item.snapshot.number === 2)?.status).toBe("analyzing");
  });
  it("pins numeric identity and fails closed when the authenticated account changes", async () => {
    const f = fixture(); await f.enable(); f.add();
    f.github.identity.mockResolvedValue({ id: 77, login: "owner" });
    await f.service.scanNow(); await f.service.tick();
    expect(f.worker.start).not.toHaveBeenCalled(); expect(f.store.state.owner?.id).toBe(42); expect(f.store.state.scan.error).toContain("account changed");
  });
  it("coalesces owner edits during a run into exactly one later analysis", async () => {
    const f = fixture(); await f.enable(); f.add(); await f.service.tick();
    f.snapshots.get(1)!.fingerprint = "revision-2"; await f.service.scanNow();
    f.snapshots.get(1)!.fingerprint = "revision-3"; await f.service.scanNow();
    expect(f.worker.start).toHaveBeenCalledTimes(1);
    f.setOutcome({ status: "completed", result }); await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(2); expect(f.store.state.items[0].run?.fingerprint).toBe("revision-3");
    await f.service.tick(); await f.service.scanNow(); await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(2); expect(f.store.state.items[0].status).toBe("completed");
  });
  it("same fingerprint across reload reconciles the existing agent without recreating", async () => {
    const f = fixture(); await f.enable(); f.add(); await f.service.tick();
    const agentId = f.store.state.items[0].run!.agentId;
    f.store.close();
    const reloaded = new Store(f.root); stores.push(reloaded);
    const service = new TriageService(reloaded, f.github as unknown as GitHubClient, f.worker as WorkerPort, () => Date.parse("2026-10-29T12:00:20Z"));
    await service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(1); expect(reloaded.state.items[0].run!.agentId).toBe(agentId);
  });
  it("retryable dispatch recovery reuses its durable run and agent IDs", async () => {
    const f = fixture(); await f.enable(); f.add();
    f.worker.start.mockRejectedValueOnce(Object.assign(new Error("offline"), { name: "WorkerError", retryable: true }));
    await f.service.tick(); const first = structuredClone(f.store.state.items[0].run);
    f.advance(31_000); await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(2); expect(f.store.state.items[0].run!.id).toBe(first!.id); expect(f.store.state.items[0].run!.agentId).toBe(first!.agentId);
  });
  it("failed analyses do not relaunch every scan; manual retry stops the old agent", async () => {
    const f = fixture(); await f.enable(); f.add(); await f.service.tick();
    f.setOutcome({ status: "failed", error: "invalid result" }); await f.service.tick();
    await f.service.scanNow(); await f.service.tick(); expect(f.worker.start).toHaveBeenCalledTimes(1);
    const oldId = f.store.state.items[0].run!.agentId;
    await f.service.action("owner/repo#1", "retry"); await f.service.tick();
    expect(f.worker.stop).toHaveBeenCalled(); expect(f.worker.start).toHaveBeenCalledTimes(2); expect(f.store.state.items[0].run!.agentId).not.toBe(oldId);
  });
  it("claims survive edits and reload and prevent any dispatch", async () => {
    const f = fixture(); await f.enable(); f.add(3, "old", true); await f.service.scanNow();
    await f.service.action("owner/repo#3", "claim", "Already handled elsewhere");
    f.snapshots.get(3)!.fingerprint = "edited"; await f.service.scanNow(); await f.service.tick();
    expect(f.worker.start).not.toHaveBeenCalled(); expect(f.store.state.items[0].status).toBe("claimed");
    f.store.close(); const reloaded = new Store(f.root); stores.push(reloaded); expect(reloaded.state.claims["owner/repo#3"]).toBe("Already handled elsewhere");
  });
  it("honors API reset time even for manual scans and retains the cursor after a failed page", async () => {
    const f = fixture(); await f.enable();
    const reset = Date.parse("2026-10-29T13:00:00Z");
    f.github.listIssues.mockRejectedValueOnce(new GitHubError("GitHub rate limited", { status: 429, retryAt: reset }));
    await f.service.scanNow(); expect(f.store.state.scan.nextAt).toBe(reset); expect(f.store.state.scan.cursors).toEqual({});
    await f.service.scanNow(); await f.service.tick(); expect(f.github.listIssues).toHaveBeenCalledTimes(1); expect(f.worker.start).not.toHaveBeenCalled();
    f.advance(3_600_001); await f.service.tick(); expect(f.github.listIssues).toHaveBeenCalledTimes(2); expect(f.store.state.scan.error).toBeNull();
  });
  it("continues observing active workers during pause but starts no queued GitHub work", async () => {
    const f = fixture(); await f.enable(); f.add(1); f.add(2); await f.service.tick();
    await f.service.configure({ ...f.store.state.config, enabled: false });
    f.setOutcome({ status: "completed", result }); await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(1); expect(f.store.state.items[0].status).toBe("completed");
  });
  it("checks known open issues each scan to catch comment edits without updated_at changes", async () => {
    const f = fixture(); await f.enable(); f.add(1, "old", true); await f.service.scanNow();
    f.github.listIssues.mockResolvedValueOnce([]); f.snapshots.get(1)!.fingerprint = "owner-comment-edited";
    await f.service.scanNow(); expect(f.github.getIssue).toHaveBeenCalledWith("owner/repo", 1); expect(f.store.state.items[0].status).toBe("queued");
  });
  it("removing a repo stops its running worker and blocks further dispatch", async () => {
    const f = fixture(); await f.enable(); f.add(); await f.service.tick();
    await f.service.configure({ ...f.store.state.config, enabled: false, repos: [] }); await f.service.tick();
    expect(f.worker.stop).toHaveBeenCalledTimes(1); expect(f.store.state.items[0].status).toBe("failed"); expect(f.worker.start).toHaveBeenCalledTimes(1);
  });
  it("local diagnostic is explicit and cleanable, uses the cheaper test model and never calls GitHub", async () => {
    const f = fixture(); await f.service.diagnostic("run"); await f.service.tick();
    expect(f.worker.start).toHaveBeenCalledTimes(1); expect(f.worker.start.mock.calls[0][0].settings.model).toBe("gpt-5.4-mini"); expect(f.github.identity).not.toHaveBeenCalled();
    await f.service.diagnostic("cleanup"); expect(f.worker.archive).toHaveBeenCalledTimes(1); expect(f.store.state.items).toEqual([]);
  });
});

describe("persistent store", () => {
  it("rejects a concurrent writer and preserves corrupt state instead of resetting dedup", () => {
    const f = fixture(); expect(() => new Store(f.root)).toThrow("Another triage writer");
    f.store.close(); const path = join(f.root, "state.json"); writeFileSync(path, "corrupt");
    expect(() => new Store(f.root)).toThrow("Preserved the original"); expect(readFileSync(path, "utf8")).toBe("corrupt");
  });
});

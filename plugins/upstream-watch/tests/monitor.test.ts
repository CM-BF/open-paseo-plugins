import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, type GitHubTransport } from "../server/github";
import { Monitor, OBSERVATION_MAX_AGE } from "../server/monitor";
import { Store } from "../server/store";
import { type WatchDraft } from "../shared/contracts";
import { cindyDraft } from "../shared/cindy";
import { featureReview } from "../shared/feature-review";

const BASE = "a".repeat(40),
  HEAD = "b".repeat(40),
  NEXT = "c".repeat(40);
const NOW = Date.parse("2026-10-24T12:00:00Z");
const roots: string[] = [],
  monitors: Monitor[] = [];
function draft(extra: Partial<WatchDraft> = {}): WatchDraft {
  return {
    name: "Tool",
    pluginId: "tool",
    targetPath: "/tmp/tool",
    repository: "example/tools",
    ref: "main",
    paths: [],
    relationship: "reference",
    notes: "",
    enabled: true,
    provider: "",
    ...extra,
  };
}
function response(
  head = HEAD,
  status = 200,
  headers = {},
): { status: number; headers: Record<string, string>; body: string } {
  return {
    status,
    headers,
    body: JSON.stringify({
      sha: head,
      html_url: `https://github.com/example/tools/commit/${head}`,
      commit: {
        message: "Update",
        committer: { date: new Date(NOW).toISOString() },
      },
    }),
  };
}
async function fixture(
  transport?: GitHubTransport,
  now: () => number = () => NOW,
) {
  const root = await mkdtemp(join(tmpdir(), "upstream-monitor-"));
  roots.push(root);
  const store = new Store(join(root, "state.json"));
  await store.ready;
  const calls: string[] = [];
  const github = new GitHubClient({
    now,
    transport:
      transport ??
      (async (path) => {
        calls.push(path);
        if (path.includes("/compare/"))
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              status: "ahead",
              total_commits: 1,
              commits: [JSON.parse(response().body)],
              files: [{ filename: "src/index.ts", status: "modified" }],
            }),
          };
        return response();
      }),
  });
  const monitor = new Monitor(store, github, { now });
  monitors.push(monitor);
  return { store, monitor, calls, path: store.path };
}
afterEach(async () => {
  monitors.splice(0).forEach((monitor) => monitor.dispose());
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Monitor", () => {
  it("persists the review inventory across scheduled scans and restart without advancing its baseline", async () => {
    const { monitor, store, path } = await fixture();
    await monitor.save(draft({ baseline: BASE, review: cindyDraft().review }));
    monitor.schedule();
    await vi.waitFor(async () =>
      expect((await store.read()).watches[0].checkedAt).toBeDefined(),
    );
    await monitor.waitForIdle();
    const current = (await new Store(path).read()).watches[0];
    expect(current.review?.mode).toBe("recommend-only");
    expect(current.review?.features).toHaveLength(9);
    expect(current.baseline).toBe(BASE);
    expect(
      featureReview(current)?.features.find((item) => item.id === "voice-im")
        ?.adoption,
    ).toBe("missing");
    expect((await store.read()).settings).toEqual({
      enabled: true,
      intervalHours: 24,
    });
  });
  it("saves without network, establishes first baseline, and persists it", async () => {
    const { monitor, store, calls, path } = await fixture();
    const watch = await monitor.save(draft());
    expect(calls).toEqual([]);
    expect(monitor.check(watch.id)).toBe(true);
    expect(monitor.check()).toBe(false);
    await monitor.waitForIdle();
    expect((await store.read()).watches[0]).toMatchObject({
      baseline: HEAD,
      observation: { hasUpdate: false },
    });
    expect((await new Store(path).read()).watches[0]?.baseline).toBe(HEAD);
  });
  it("keeps adopted baseline fixed while pending updates survive restart and harmless edits", async () => {
    const { monitor, store, path } = await fixture();
    const watch = await monitor.save(draft({ baseline: BASE }));
    monitor.check();
    await monitor.waitForIdle();
    const pending = (await store.read()).watches[0]!;
    expect(pending).toMatchObject({
      baseline: BASE,
      observation: { head: HEAD, hasUpdate: true },
    });
    const paused = await monitor.save({
      ...pending,
      enabled: false,
      name: "Renamed",
      notes: "Keep this",
      provider: "codex",
    });
    expect(paused.observation?.hasUpdate).toBe(true);
    expect(
      (await new Store(path).read()).watches[0]?.observation?.hasUpdate,
    ).toBe(true);
    const changed = await monitor.save({ ...paused, ref: "other" });
    expect(changed.observation).toBeUndefined();
    expect(watch.baseline).toBe(BASE);
  });
  it("advances only the exact successfully checked head, then clears pending", async () => {
    const { monitor, store } = await fixture();
    const watch = await monitor.save(draft({ baseline: BASE }));
    monitor.check();
    await monitor.waitForIdle();
    await expect(monitor.acknowledge(watch.id, NEXT)).rejects.toThrow(
      "head changed",
    );
    expect((await store.read()).watches[0]?.baseline).toBe(BASE);
    const result = await monitor.acknowledge(watch.id, HEAD);
    expect(result).toMatchObject({
      baseline: HEAD,
      observation: { hasUpdate: false, comparison: "identical" },
    });
  });
  it("preserves pending observation on failure, records retry time, and refuses acknowledgement", async () => {
    let failed = false;
    const { monitor, store } = await fixture(async (path) => {
      if (failed) return response(HEAD, 429, { "retry-after": "120" });
      if (path.includes("/compare/"))
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            status: "ahead",
            total_commits: 1,
            commits: [JSON.parse(response().body)],
            files: [],
          }),
        };
      return response();
    });
    const watch = await monitor.save(draft({ baseline: BASE }));
    monitor.check();
    await monitor.waitForIdle();
    failed = true;
    monitor.check();
    await monitor.waitForIdle();
    const result = (await store.read()).watches[0]!;
    expect(result).toMatchObject({
      baseline: BASE,
      observation: { hasUpdate: true },
      retryAt: new Date(NOW + 120_000).toISOString(),
    });
    expect(result.error).toContain("rate limited");
    await expect(monitor.acknowledge(watch.id, HEAD)).rejects.toThrow(
      "successfully again",
    );
  });
  it("does not acknowledge stale observations", async () => {
    let time = NOW;
    const { monitor } = await fixture(undefined, () => time);
    const watch = await monitor.save(draft({ baseline: BASE }));
    monitor.check();
    await monitor.waitForIdle();
    time += OBSERVATION_MAX_AGE + 1;
    await expect(monitor.acknowledge(watch.id, HEAD)).rejects.toThrow(
      "successfully again",
    );
  });
  it.each(["edit", "delete"])(
    "discards in-flight result after concurrent %s",
    async (action) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const { monitor, store } = await fixture(async (path) => {
        began();
        await gate;
        if (path.includes("/compare/"))
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              status: "ahead",
              total_commits: 0,
              commits: [],
              files: [],
            }),
          };
        return response();
      });
      const watch = await monitor.save(draft({ baseline: BASE }));
      monitor.check();
      await started;
      if (action === "edit")
        await monitor.save({ ...watch, notes: "Edited while checking" });
      else await monitor.remove(watch.id);
      release();
      await monitor.waitForIdle();
      monitor.dispose();
      const watches = (await store.read()).watches;
      if (action === "edit")
        expect(watches[0]).toMatchObject({
          notes: "Edited while checking",
          baseline: BASE,
          observation: undefined,
        });
      else expect(watches).toEqual([]);
    },
  );
  it("bounds watch and path counts", async () => {
    const { monitor, store } = await fixture();
    await expect(
      monitor.save(
        draft({ paths: Array.from({ length: 21 }, (_, i) => `p${i}`) }),
      ),
    ).rejects.toThrow();
    const base = await monitor.save(draft());
    await store.change((state) => {
      state.watches = Array.from({ length: 100 }, () => ({
        ...base,
        id: randomUUID(),
      }));
    });
    await expect(monitor.save(draft())).rejects.toThrow("100 watches");
  });
  it("on startup checks only overdue enabled watches, preserving daily due time across restart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    const { monitor, store, calls } = await fixture(undefined, Date.now);
    const overdue = await monitor.save(draft({ name: "Overdue" }));
    const fresh = await monitor.save(draft({ name: "Fresh" }));
    const disabled = await monitor.save(
      draft({ name: "Disabled", enabled: false }),
    );
    const limited = await monitor.save(draft({ name: "Limited" }));
    await store.change((state) => {
      state.watches.find((w) => w.id === overdue.id)!.checkedAt = new Date(
        NOW - 25 * 60 * 60 * 1000,
      ).toISOString();
      state.watches.find((w) => w.id === fresh.id)!.checkedAt = new Date(
        NOW - 2 * 60 * 60 * 1000,
      ).toISOString();
      state.watches.find((w) => w.id === disabled.id)!.checkedAt = new Date(
        NOW - 30 * 60 * 60 * 1000,
      ).toISOString();
      state.watches.find((w) => w.id === limited.id)!.retryAt = new Date(
        NOW + 2 * 60 * 60 * 1000,
      ).toISOString();
    });
    monitor.schedule();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await monitor.waitForIdle();
    expect(
      (await store.read()).watches.find((w) => w.id === overdue.id)?.baseline,
    ).toBe(HEAD);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await monitor.waitForIdle();
    monitor.dispose();
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000);
    expect(calls).toHaveLength(2);
  });
  it("aborts active requests when disposed", async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let sawAbort = false;
    const { monitor, store } = await fixture(async (_path, signal) => {
      began();
      return new Promise((_resolve, reject) =>
        signal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            reject(new Error("aborted"));
          },
          { once: true },
        ),
      );
    });
    await monitor.save(draft());
    monitor.check();
    await started;
    monitor.dispose();
    await monitor.waitForIdle();
    expect(sawAbort).toBe(true);
    expect((await store.read()).watches[0]?.error).toBeUndefined();
    expect(monitor.check()).toBe(false);
  });
  it.each(["success", "failure"])(
    "stops the rest of a scheduled batch after global pause during a %s response",
    async (outcome) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const requested: string[] = [];
      const { monitor, store } = await fixture(async (path) => {
        requested.push(path);
        if (path.includes("/first/")) {
          began();
          await gate;
          if (outcome === "failure")
            throw new Error("network failed after pause");
        }
        return response();
      });
      await monitor.save(draft({ repository: "example/first" }));
      await monitor.save(draft({ repository: "example/second" }));
      monitor.schedule();
      await started;
      await store.change((state) => {
        state.settings.enabled = false;
      });
      monitor.schedule();
      release();
      await monitor.waitForIdle();
      expect(requested).toEqual(["/repos/example/first/commits/main"]);
      const watches = (await store.read()).watches;
      expect(
        watches.every(
          (watch) =>
            !watch.checkedAt &&
            !watch.observation &&
            !watch.error &&
            !watch.baseline,
        ),
      ).toBe(true);
    },
  );
  it.each(["pause", "delete"])(
    "does not request a queued watch after concurrent %s while the first request is pending",
    async (action) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const requested: string[] = [];
      const { monitor, store } = await fixture(async (path) => {
        requested.push(path);
        if (path.includes("/first/")) {
          began();
          await gate;
        }
        return response();
      });
      const first = await monitor.save(draft({ repository: "example/first" }));
      const second = await monitor.save(
        draft({ repository: "example/second" }),
      );
      monitor.check();
      await started;
      if (action === "pause") await monitor.save({ ...second, enabled: false });
      else await monitor.remove(second.id);
      release();
      await monitor.waitForIdle();
      monitor.dispose();
      expect(requested).toEqual(["/repos/example/first/commits/main"]);
      const watches = (await store.read()).watches;
      expect(watches.find((watch) => watch.id === first.id)?.baseline).toBe(
        HEAD,
      );
      const queued = watches.find((watch) => watch.id === second.id);
      if (action === "pause") {
        expect(queued?.enabled).toBe(false);
        expect(queued?.baseline).toBeUndefined();
        expect(queued?.checkedAt).toBeUndefined();
        expect(queued?.observation).toBeUndefined();
      } else expect(queued).toBeUndefined();
    },
  );
});

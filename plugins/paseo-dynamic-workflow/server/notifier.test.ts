import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PaseoApi } from "./gate";
import { Notifier } from "./notifier";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(refresh = vi.fn(async () => ({ agent: { status: "idle", activeTurn: null, archivedAt: null } }))) {
  const dir = await mkdtemp(join(tmpdir(), "dwf-notifier-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const send = vi.fn(async (_text: string, _options: unknown) => {});
  const file = join(dir, "outbox.json");
  const notifier = new Notifier(file, () => ({ agents: { ref: () => ({ refresh, send }) } }) as unknown as PaseoApi);
  await notifier.load();
  cleanup.push(() => notifier.dispose());
  return { notifier, send, refresh, file };
}

it("retains pending notifications on transient refresh failure and delivers after recovery", async () => {
  const f = await fixture();
  f.refresh.mockRejectedValueOnce(new Error("connection closed"));
  f.notifier.add({ id: "one", agentId: "p", text: "result" });
  await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
  expect(f.notifier.pendingFor("p")).toBe(1);
  await vi.waitFor(() => { f.notifier.kick("p"); expect(f.send).toHaveBeenCalledOnce(); });
  expect(f.send).toHaveBeenCalledWith("result", { messageId: "one", activeTurnBehavior: "steer" });
});

it("quarantines an ambiguous receipt without blocking later notifications", async () => {
  const f = await fixture();
  f.send.mockRejectedValueOnce(new Error("agent_request_outcome_unknown"));
  f.notifier.add({ id: "one", agentId: "p", text: "first" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  f.notifier.add({ id: "two", agentId: "p", text: "second" });
  await vi.waitFor(() => { f.notifier.kick("p"); expect(f.send).toHaveBeenCalledTimes(2); });
  expect(f.send.mock.calls[1]?.[0]).toBe("second");
  await f.notifier.dispose();
  const outbox = JSON.parse(await readFile(f.file, "utf8"));
  expect(outbox.entries).toEqual([expect.objectContaining({ id: "one", uncertain: true })]);
});

it("persists shutdown notifications without starting delivery", async () => {
  const f = await fixture();
  f.notifier.pause();
  f.notifier.add({ id: "one", agentId: "p", text: "interrupted" });
  await f.notifier.dispose();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.file, "utf8")).entries).toHaveLength(1);
});

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

it("supersedes a known failed notice without changing or replaying its receipt", async () => {
  const failure = "temporary transport error";
  const f = await fixture();
  f.send.mockRejectedValueOnce(new Error(failure));
  f.notifier.add({ id: "notify-wf_test", agentId: "p", text: "Ultracode on" });
  await vi.waitFor(async () => {
    const entries = JSON.parse(await readFile(f.file, "utf8")).entries;
    expect(entries[0]).toMatchObject({ attempts: 1, lastError: failure });
  });
  f.notifier.replacePending("notify-wf_test", "Ultracode off");
  await vi.waitFor(() => { f.notifier.kick("p"); expect(f.send).toHaveBeenCalledTimes(2); });
  expect(f.send.mock.calls[1]?.[0]).toBe("Ultracode off");
  expect(f.send.mock.calls[1]?.[1]).not.toMatchObject({ messageId: "notify-wf_test" });
  f.notifier.kick("p");
  await f.notifier.dispose();
  const entries = JSON.parse(await readFile(f.file, "utf8")).entries;
  expect(entries).toEqual([expect.objectContaining({ id: "notify-wf_test", text: "Ultracode on", superseded: true })]);
  expect(f.send).toHaveBeenCalledTimes(2);
});

it("retires failed mode notices before sending the latest mode", async () => {
  const f = await fixture();
  f.send.mockRejectedValueOnce(new Error("temporary transport error"));
  f.notifier.add({ id: "ultracode-p-on", agentId: "p", text: "on" });
  await vi.waitFor(async () => expect(JSON.parse(await readFile(f.file, "utf8")).entries[0].lastError).toBe("temporary transport error"));
  f.notifier.supersede("ultracode-p-");
  f.notifier.add({ id: "ultracode-p-off", agentId: "p", text: "off" });
  await vi.waitFor(() => { f.notifier.kick("p"); expect(f.send).toHaveBeenCalledTimes(2); });
  expect(f.send.mock.calls.map(([text]) => text)).toEqual(["on", "off"]);
  await f.notifier.dispose();
  expect(JSON.parse(await readFile(f.file, "utf8")).entries).toEqual([expect.objectContaining({ id: "ultracode-p-on", superseded: true })]);
});

it("orders the latest mode after an in-flight stale send without reusing its receipt", async () => {
  const f = await fixture();
  let release!: () => void;
  f.send.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  f.notifier.add({ id: "ultracode-p-on", agentId: "p", text: "on" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  f.notifier.supersede("ultracode-p-");
  f.notifier.add({ id: "ultracode-p-off", agentId: "p", text: "off" });
  expect(f.send).toHaveBeenCalledOnce();
  release();
  await vi.waitFor(() => { f.notifier.kick("p"); expect(f.send).toHaveBeenCalledTimes(2); });
  expect(f.send.mock.calls.map(([text]) => text)).toEqual(["on", "off"]);
});

it("does not bypass an uncertain run receipt with a replacement id", async () => {
  const f = await fixture();
  f.send.mockRejectedValueOnce(new Error("agent_request_outcome_unknown"));
  f.notifier.add({ id: "notify-wf_test", agentId: "p", text: "Ultracode on" });
  await vi.waitFor(async () => expect(JSON.parse(await readFile(f.file, "utf8")).entries[0].uncertain).toBe(true));
  f.notifier.replacePending("notify-wf_test", "Ultracode off");
  f.notifier.kick("p");
  await f.notifier.dispose();
  expect(f.send).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(f.file, "utf8")).entries).toEqual([expect.objectContaining({ id: "notify-wf_test", text: "Ultracode on", uncertain: true })]);
});

it("waits for an in-flight run receipt before deciding whether a changed payload may retry", async () => {
  const f = await fixture();
  let reject!: (error: Error) => void;
  f.send.mockImplementationOnce(() => new Promise<void>((_resolve, rejectSend) => { reject = rejectSend; }));
  f.notifier.add({ id: "notify-wf_test", agentId: "p", text: "Ultracode on" });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  f.notifier.replacePending("notify-wf_test", "Ultracode off");
  reject(new Error("agent_request_outcome_unknown"));
  await vi.waitFor(async () => expect(JSON.parse(await readFile(f.file, "utf8")).entries[0].uncertain).toBe(true));
  f.notifier.kick("p");
  await f.notifier.dispose();
  expect(f.send).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(f.file, "utf8")).entries).toHaveLength(1);
});

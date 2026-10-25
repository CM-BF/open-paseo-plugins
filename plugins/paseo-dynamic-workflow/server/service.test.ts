import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES } from "../shared/settings";
import { LABEL_RUN } from "../shared/ids";
import { Gate, type PaseoApi } from "./gate";
import { readRecord, RunFiles } from "./run-store";
import { WorkflowService } from "./service";
import { meta, tempState } from "./test-harness";

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture(guidance?: { current: { ultracode: boolean; size: "unrestricted" | "small" | "medium" | "large" } }) {
  const paths = await tempState();
  disposals.push(() => rm(paths.root, { recursive: true, force: true }));
  const gate = new Gate();
  const timeline = {
    refetch: vi.fn(async (_options: unknown) => ({ entries: [], hasOlder: false, startCursor: null })),
    append: vi.fn(async () => ({})),
  };
  const refresh = vi.fn(async () => ({ agent: {
    id: "parent", provider: "codex", model: "test", cwd: paths.root, workspaceId: "fixture",
    status: "running", activeTurn: {}, labels: {}, archivedAt: null, currentModeId: "auto",
  } }));
  gate.capture({ agents: { ref: () => ({ refresh, timeline }) } } as unknown as PaseoApi);
  const service = new WorkflowService({ paths, gate, settings: () => DEFAULT_PREFERENCES, ...(guidance ? { guidance: () => guidance.current } : {}) });
  await mkdir(paths.runs, { recursive: true });
  await service.recover();
  disposals.push(() => service.dispose());
  return { paths, gate, service, refresh, timeline };
}

const userMessage = (text: string, seq: number) => ({ entries: [{ item: { type: "user_message", text }, timestamp: `t${seq}`, seqStart: seq }], hasOlder: false, startCursor: null });
const runId = (text: string) => text.match(/Run ID: (wf_[a-z0-9]+)/)![1]!;

it("copies named source for editing and persists args across resume without altering the library", async () => {
  const f = await fixture();
  const dir = join(f.paths.root, ".paseo", "workflows");
  await mkdir(dir, { recursive: true });
  const saved = join(dir, "fixture.js");
  const script = meta("fixture") + "return args.value";
  await writeFile(saved, script);
  const text = await f.service.launch("parent", { name: "fixture", args: { value: 17 } });
  const id = text.match(/Run ID: (wf_[a-z0-9]+)/)![1]!;
  await vi.waitFor(async () => expect((await readRecord(f.paths, id))?.status).toBe("completed"));
  const first = (await readRecord(f.paths, id))!;
  expect(first.scriptPath).not.toBe(saved);
  expect(first.sourcePath).toBe(saved);
  expect(first.args).toEqual({ value: 17 });
  await writeFile(first.scriptPath, meta("fixture") + "return args.value + 1");
  const resumed = await f.service.launch("parent", { scriptPath: first.scriptPath, resumeFromRunId: id });
  const resumedId = resumed.match(/Run ID: (wf_[a-z0-9]+)/)![1]!;
  await vi.waitFor(async () => expect((await readRecord(f.paths, resumedId))?.status).toBe("completed"));
  expect(JSON.parse(await readFile(join(f.paths.runs, resumedId, "result.json"), "utf8"))).toBe(18);
  expect(await readFile(saved, "utf8")).toBe(script);
  await expect(f.service.status("other", id, 0)).rejects.toThrow("belongs to another");
  await expect(f.service.launch("other", { script: meta() + "return 0", resumeFromRunId: id })).rejects.toThrow("belongs to another");
});

it("persists interruption and its outbox notification before shutdown finishes", async () => {
  const f = await fixture();
  const text = await f.service.launch("parent", { script: meta() + "await new Promise(r => setTimeout(r, 60000)); return 1" });
  const id = text.match(/Run ID: (wf_[a-z0-9]+)/)![1]!;
  await f.service.dispose();
  expect((await readRecord(f.paths, id))?.status).toBe("interrupted");
  const outbox = JSON.parse(await readFile(f.paths.outbox, "utf8"));
  expect(outbox.entries).toEqual([expect.objectContaining({ agentId: "parent", id: `notify-${id}` })]);
});

it("rejects launches from workflow children", async () => {
  const f = await fixture();
  const snapshot = await f.refresh();
  snapshot.agent.labels = { [LABEL_RUN]: "wf_fixture" };
  f.refresh.mockResolvedValue(snapshot);
  await expect(f.service.launch("parent", { script: meta() + "return 1" })).rejects.toThrow("cannot launch");
});

it("does not start a pending launch after disposal", async () => {
  const f = await fixture();
  const snapshot = await f.refresh();
  let release!: (value: typeof snapshot) => void;
  f.refresh.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const pending = f.service.launch("parent", { script: meta() + "return 1" });
  await vi.waitFor(() => expect(release).toBeDefined());
  await f.service.dispose();
  release(snapshot);
  await expect(pending).rejects.toThrow("stopped before this launch");
  expect(await f.service.list(undefined, 10)).toEqual([]);
});

it("recovers a completed result that had not yet been queued for notification", async () => {
  const f = await fixture();
  const text = await f.service.launch("parent", { script: meta() + "return 1" });
  const id = text.match(/Run ID: (wf_[a-z0-9]+)/)![1]!;
  await vi.waitFor(async () => expect((await readRecord(f.paths, id))?.status).toBe("completed"));
  await f.service.dispose();
  const record = (await readRecord(f.paths, id))!;
  record.notified = false;
  await new RunFiles(f.paths, id).saveRecord(record);
  await rm(f.paths.outbox, { force: true });
  const recovered = new WorkflowService({ paths: f.paths, gate: f.gate, settings: () => DEFAULT_PREFERENCES });
  disposals.push(() => recovered.dispose());
  await recovered.recover();
  expect(recovered.notifier.pendingFor("parent")).toBe(1);
  expect((await readRecord(f.paths, id))?.notified).toBe(true);
});

it("states the caller's guidance, keeps the first run's guidance on resume, and asks for a check-in on long chains", async () => {
  const guidance: { current: { ultracode: boolean; size: "unrestricted" | "small" | "medium" | "large" } } = { current: { ultracode: true, size: "unrestricted" } };
  const f = await fixture(guidance);
  f.timeline.refetch.mockResolvedValue(userMessage("review this", 1) as never);
  const first = await f.service.launch("parent", { script: meta() + "return guidance" });
  expect(first).toContain("Ultracode is on for you");
  const id = runId(first);
  await vi.waitFor(async () => expect((await readRecord(f.paths, id))?.status).toBe("completed"));
  expect(JSON.parse(await readFile(join(f.paths.runs, id, "result.json"), "utf8"))).toEqual({ ultracode: true, size: "unrestricted" });

  // Turning Ultracode off wins over cache reuse.
  guidance.current = { ultracode: false, size: "small" };
  const dropped = await f.service.launch("parent", { script: meta() + "return guidance", resumeFromRunId: id });
  expect(dropped).toContain("Ultracode is off for you");
  expect(dropped).toContain(`The user turned Ultracode off after ${id}`);
  const droppedId = runId(dropped);
  await vi.waitFor(async () => expect((await readRecord(f.paths, droppedId))?.status).toBe("completed"));
  expect(JSON.parse(await readFile(join(f.paths.runs, droppedId, "result.json"), "utf8"))).toEqual({ ultracode: false, size: "small" });

  // Any other change keeps the first run's guidance, so its cached results stay valid.
  guidance.current = { ultracode: true, size: "unrestricted" };
  const resumed = await f.service.launch("parent", { script: meta() + "return guidance", resumeFromRunId: droppedId });
  expect(resumed).toContain("Ultracode is on for you");
  expect(resumed).toContain(`This resume keeps the guidance of ${droppedId} (Ultracode off, size small)`);
  const resumedId = runId(resumed);
  await vi.waitFor(async () => expect((await readRecord(f.paths, resumedId))?.status).toBe("completed"));
  expect(JSON.parse(await readFile(join(f.paths.runs, resumedId, "result.json"), "utf8"))).toEqual({ ultracode: false, size: "small" });

  const fourth = await f.service.launch("parent", { script: meta() + "return 4" });
  expect(fourth).not.toContain("you launched since");
  guidance.current = { ultracode: false, size: "unrestricted" };
  const fifth = await f.service.launch("parent", { script: meta() + "return 'b'" });
  expect(fifth).toContain("This is run 5 you launched since the user's last message");
  f.timeline.refetch.mockResolvedValue(userMessage("go on", 2) as never);
  expect(await f.service.launch("parent", { script: meta() + "return 5" })).not.toContain("you launched since");
});

it("re-renders a queued notification when the user changes Ultracode before it is delivered", async () => {
  const guidance: { current: { ultracode: boolean; size: "unrestricted" | "small" | "medium" | "large" } } = { current: { ultracode: true, size: "unrestricted" } };
  const f = await fixture(guidance);
  // The parent stays mid-turn, so the notification waits in the outbox.
  const id = runId(await f.service.launch("parent", { script: meta() + "return 1" }));
  const queued = async () => JSON.parse(await readFile(f.paths.outbox, "utf8")).entries.find((entry: { id: string }) => entry.id === `notify-${id}`)?.text as string | undefined;
  await vi.waitFor(async () => expect(await queued()).toContain("continue with its next phase as a workflow"));
  guidance.current = { ultracode: false, size: "unrestricted" };
  await f.service.refreshNotifications("parent");
  await vi.waitFor(async () => expect(await queued()).toContain("Ultracode is off for you"));
  expect(await queued()).not.toContain("continue with its next phase");
});

it("refreshes attempted run notices under a new immutable receipt across repeated mode changes", async () => {
  const guidance: { current: { ultracode: boolean; size: "unrestricted" | "small" | "medium" | "large" } } = { current: { ultracode: true, size: "unrestricted" } };
  const f = await fixture(guidance);
  const id = runId(await f.service.launch("parent", { script: meta() + "return 1" }));
  const entries = async () => JSON.parse(await readFile(f.paths.outbox, "utf8")).entries as Array<{ id: string; logicalId?: string; text: string; attempts: number; lastError: string | null; superseded?: boolean }>;
  await vi.waitFor(async () => expect((await entries())[0]?.text).toContain("continue with its next phase"));
  const send = vi.fn(async () => { throw new Error("temporary transport error"); });
  f.gate.capture({ agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", activeTurn: null, archivedAt: null } }), send }) } } as unknown as PaseoApi);
  await vi.waitFor(async () => { f.service.notifier.kick("parent"); expect((await entries())[0]?.lastError).toBe("temporary transport error"); });
  f.service.notifier.pause();
  guidance.current = { ultracode: false, size: "small" };
  await f.service.refreshNotifications("parent");
  guidance.current = { ultracode: false, size: "medium" };
  await f.service.refreshNotifications("parent");
  await vi.waitFor(async () => {
    const queued = await entries();
    expect(queued).toHaveLength(2);
    expect(queued[0]).toMatchObject({ id: `notify-${id}`, attempts: 1, superseded: true, text: expect.stringContaining("continue with its next phase") });
    expect(queued[1]).toMatchObject({ logicalId: `notify-${id}`, attempts: 0, text: expect.stringContaining("size guideline medium") });
    expect(queued[1]!.id).not.toBe(queued[0]!.id);
    expect(queued[1]!.text).not.toContain("continue with its next phase");
  });
  expect(send).toHaveBeenCalledOnce();
});

it("keeps an uncertain logical run receipt quarantined when guidance changes", async () => {
  const guidance: { current: { ultracode: boolean; size: "unrestricted" | "small" | "medium" | "large" } } = { current: { ultracode: true, size: "unrestricted" } };
  const f = await fixture(guidance);
  const id = runId(await f.service.launch("parent", { script: meta() + "return 1" }));
  const entries = async () => JSON.parse(await readFile(f.paths.outbox, "utf8")).entries;
  await vi.waitFor(async () => expect((await entries())[0]?.id).toBe(`notify-${id}`));
  const send = vi.fn(async () => { throw new Error("agent_request_outcome_unknown"); });
  f.gate.capture({ agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", activeTurn: null, archivedAt: null } }), send }) } } as unknown as PaseoApi);
  await vi.waitFor(async () => { f.service.notifier.kick("parent"); expect((await entries())[0]?.uncertain).toBe(true); });
  guidance.current = { ultracode: false, size: "small" };
  await f.service.refreshNotifications("parent");
  await f.service.notifier.dispose();
  expect(send).toHaveBeenCalledOnce();
  expect(await entries()).toEqual([expect.objectContaining({ id: `notify-${id}`, attempts: 1, uncertain: true })]);
});

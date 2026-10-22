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

async function fixture() {
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
  const service = new WorkflowService({ paths, gate, settings: () => DEFAULT_PREFERENCES });
  await mkdir(paths.runs, { recursive: true });
  await service.recover();
  disposals.push(() => service.dispose());
  return { paths, gate, service, refresh, timeline };
}

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

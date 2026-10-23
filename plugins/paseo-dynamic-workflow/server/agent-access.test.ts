import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentAccessStore } from "./agent-access";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dwf-access-"));
  dirs.push(dir);
  const file = join(dir, "agent-access.json");
  return { file, store: new AgentAccessStore(file) };
}

it("defaults to disabled and persists independent concurrent agent choices", async () => {
  const { file, store } = await fixture();
  await store.load();
  expect(store.enabled("a")).toBe(false);
  await Promise.all([store.set("a", true), store.set("b", true), store.set("a", false), store.set("c", true)]);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, enabledAgentIds: ["b", "c"] });
  const restarted = new AgentAccessStore(file);
  await restarted.load();
  expect(["a", "b", "c", "new"].map((id) => restarted.enabled(id))).toEqual([false, true, true, false]);
});

it.each(["broken json", '{"version":2,"enabledAgentIds":["a"]}', '{"version":1,"enabledAgentIds":["a",4]}'])("fails closed for an invalid access file: %s", async (text) => {
  const { file, store } = await fixture();
  await writeFile(file, text);
  await store.load();
  expect(store.enabled("a")).toBe(false);
});

it("reports failed durable writes without granting access and permits a later retry", async () => {
  const { file, store } = await fixture();
  await store.load();
  await mkdir(file);
  await expect(store.set("a", true)).rejects.toThrow();
  expect(store.enabled("a")).toBe(false);
  await rm(file, { recursive: true });
  await store.set("a", true);
  expect(store.enabled("a")).toBe(true);
  expect(JSON.parse(await readFile(file, "utf8")).enabledAgentIds).toEqual(["a"]);
});

it("rejects state mutations after shutdown begins", async () => {
  const { store } = await fixture();
  store.dispose();
  await expect(store.set("a", true)).rejects.toThrow("stopping");
  expect(store.enabled("a")).toBe(false);
  await store.idle();
});

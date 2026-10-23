import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { renderMcp } from "./scripts";

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

// Exercise the complete rendered stdio program. Only its file reads and watch events are
// controlled: hold an old snapshot while a newer access change reaches the watcher.
const PRELOAD = String.raw`
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

let access = JSON.stringify({ version: 1, enabledAgentIds: [] });
let armed = false;
let release;
let changed;
const readFile = fs.promises.readFile;
fs.promises.readFile = async (file, ...args) => {
  if (!String(file).endsWith('/agent-access.json')) return readFile(file, ...args);
  const snapshot = access;
  if (armed) {
    armed = false;
    const held = new Promise(resolve => { release = resolve; });
    process.send({ type: 'held' });
    await held;
  }
  return snapshot;
};
fs.watch = (_directory, listener) => {
  changed = listener;
  const watcher = new EventEmitter();
  watcher.close = () => {};
  return watcher;
};
syncBuiltinESMExports();
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  process.send({ type: 'output', value: JSON.parse(String(chunk)) });
  return write(chunk, ...args);
};
process.on('message', command => {
  if (command === 'arm') {
    armed = true;
    process.send({ type: 'armed' });
  } else if (command === 'enable') {
    access = JSON.stringify({ version: 1, enabledAgentIds: ['agent-a'] });
    changed('rename', 'agent-access.json');
    // All immediately resolving file reads and their promise continuations finish first.
    setImmediate(() => process.send({ type: 'changed' }));
  } else if (command === 'release') {
    release();
  }
});
`;

interface Message {
  type: string;
  value?: { id?: number; method?: string; result?: { tools?: unknown[] } }
    | Array<{ id?: number; result?: { tools?: unknown[] } }>;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dwf-availability-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const program = join(root, "mcp.mjs");
  const preload = join(root, "preload.mjs");
  await Promise.all([writeFile(program, renderMcp()), writeFile(preload, PRELOAD)]);
  const child = spawn(process.execPath, ["--import", preload, program], {
    env: { ...process.env, DYNAMIC_WORKFLOW_HOME: root, PASEO_AGENT_ID: "agent-a", PASEO_DYNAMIC_WORKFLOW_BINDING: "" },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  disposals.push(async () => { child.kill(); await exited; });
  const messages: Message[] = [];
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  child.on("message", (message) => messages.push(message as Message));
  const send = (value: unknown) => child.stdin!.write(`${JSON.stringify(value)}\n`);
  const wait = async (type: string) => vi.waitFor(() => {
    expect(stderr).toBe("");
    expect(messages.some((message) => message.type === type)).toBe(true);
  });
  const output = () => messages.filter((message) => message.type === "output").map((message) => message.value!);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await wait("output");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await vi.waitFor(() => expect(output().some((message) => !Array.isArray(message) && message.id === 2)).toBe(true));
  messages.length = 0;
  return { child, messages, send, wait, output };
}

it.each([false, true])("publishes an in-flight tool list before the newer access notification (batch: %s)", async (batch) => {
  const f = await fixture();
  f.child.send("arm");
  await f.wait("armed");
  const listing = { jsonrpc: "2.0", id: 3, method: "tools/list" };
  f.send(batch ? [listing, { jsonrpc: "2.0", id: 4, method: "ping" }] : listing);
  await f.wait("held");
  f.child.send("enable");
  await f.wait("changed");
  expect(f.output()).toEqual([]);
  f.child.send("release");
  await vi.waitFor(() => expect(f.output()).toHaveLength(2));
  const [response, notification] = f.output();
  const listed = Array.isArray(response) ? response.find((item) => item.id === 3) : response;
  expect(listed).toMatchObject({ id: 3, result: { tools: [] } });
  expect(notification).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  f.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  await vi.waitFor(() => expect(f.output().some((message) => !Array.isArray(message) && message.id === 5)).toBe(true));
  expect(f.output().find((message) => !Array.isArray(message) && message.id === 5)).toMatchObject({ result: { tools: expect.any(Array) } });
  const fresh = f.output().find((message) => !Array.isArray(message) && message.id === 5);
  expect(!Array.isArray(fresh) && fresh?.result?.tools).toHaveLength(4);
});

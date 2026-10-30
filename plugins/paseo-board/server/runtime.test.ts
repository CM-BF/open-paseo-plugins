import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { BoardStore } from "./store";
import { ServiceJournal } from "./journal";
import { BoardService } from "./service";
import { BoardBridge } from "./bridge";
import { runtimePaths, writeRuntime } from "./runtime";
import { boardInstructions, replaceInstructions } from "./prompts";

const exec = promisify(execFile);

function canvasBase(board: { canvas: { revision: number; documentVersion: number } }) {
  return { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion };
}

function mcpClient(executable: string, binding: string) {
  const child = spawn(executable, [], { env: { ...process.env, PASEO_BOARD_BINDING: binding }, stdio: ["pipe", "pipe", "pipe"] });
  let pending = ""; let next = 0;
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  child.stdout.on("data", chunk => {
    pending += chunk;
    for (;;) {
      const index = pending.indexOf("\n"); if (index < 0) break;
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      const message = JSON.parse(line); waiting.get(message.id)?.(message);
    }
  });
  const call = (method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++next;
    const timeout = setTimeout(() => { waiting.delete(id); reject(new Error("MCP response timed out")); }, 5000);
    waiting.set(id, message => { clearTimeout(timeout); waiting.delete(id); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { call, close: () => child.kill() };
}

function toolValue(reply: Record<string, unknown>) {
  const result = reply.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content.find(item => item.type === "text")!.text);
}

describe("installed CLI and stdio MCP transport", () => {
  let dir: string; let service: BoardService; let bridge: BoardBridge;
  beforeEach(async () => {
    dir = await mkdtemp("/tmp/pb-");
    const store = new BoardStore(join(dir, "data")); await store.init();
    const journal = new ServiceJournal(join(dir, "data", "service.json")); await journal.init();
    service = new BoardService(store, journal, () => undefined); bridge = new BoardBridge(service);
    await writeRuntime(runtimePaths(dir)); await bridge.start(runtimePaths(dir).socket);
  });
  afterEach(async () => { await bridge.close(); await service.dispose(); await rm(dir, { recursive: true, force: true }); });

  it("uses the live IPC service for create, file publish, silent emit and idempotent read", async () => {
    const paths = runtimePaths(dir);
    const invoke = async (op: string, value: unknown) => {
      const input = join(dir, "input.json"); await writeFile(input, JSON.stringify(value));
      const result = await exec(paths.cli, [op, "--file", input], { env: { ...process.env, PASEO_BOARD_BINDING: "" }, timeout: 5000 }); return JSON.parse(result.stdout);
    };
    const created = await invoke("create", { id: "cli-board", title: "完全自由", ownerAgentId: "owner", html: "<canvas></canvas>" });
    expect(created).toMatchObject({ id: "cli-board", revision: 1 }); expect(created.canvas).toBeUndefined();
    const html = join(dir, "animation.html"); await writeFile(html, "<input id='free'><script>globalThis.count=0</script>");
    const original = await invoke("read", { boardId: "cli-board" });
    await invoke("publish", { boardId: "cli-board", expectedRevision: original.revision, canvasBase: canvasBase(original), replaceDocument: true, eventId: "html1", htmlFile: html });
    const afterHtml = await invoke("read", { boardId: "cli-board" });
    const update = { boardId: "cli-board", canvasBase: canvasBase(afterHtml), eventId: "event1", source: "async-shell-test", summary: "New result", data: { result: 42 }, focusSelectors: ["#free"] };
    const first = await invoke("emit", update); const repeated = await invoke("emit", update); expect(repeated.revision).toBe(first.revision);
    const board = await invoke("read", { boardId: "cli-board" }); expect(board.canvas.html).toContain("globalThis.count=0"); expect(board.canvas.data).toEqual({ result: 42 });
    expect(board.interactions).toEqual([]); // Emits do not enqueue messages or wake agents.
    expect(board.updates).toMatchObject([{ kind: "document", targets: [] }, { id: "event1", kind: "data", targets: [{ selector: "#free" }] }]);
    await expect(invoke("updates-seen", { boardId: "cli-board", updateIds: ["event1"] })).rejects.toThrow();
    expect((await service.store.read("cli-board"))!.seenUpdateIds).toEqual([]); // User RPC only, not an agent CLI/MCP operation.
    await service.store.addInteraction({ boardId: "cli-board", intentId: "visual-question", kind: "question", text: "Explain this" }, "owner");
    const answered = await invoke("respond", { boardId: "cli-board", interactionId: "visual-question", expectedResponseRevision: 0, eventId: "visual-answer", response: "Interactive reply", htmlFile: html });
    expect(answered).toMatchObject({ id: "visual-question", status: "answered", responseRevision: 1, responseCanvas: { html: expect.stringContaining("globalThis.count=0") } });
    expect((await stat(paths.socket)).mode & 0o777).toBe(0o600);
  });

  it("lets a bound fork publish through the installed CLI without a return-to-owner step", async () => {
    const paths = runtimePaths(dir);
    await service.store.create({ id: "shared", title: "Shared Board", ownerAgentId: "owner", html: '<main id="target"></main>' });
    await service.store.addInteraction({ boardId: "shared", intentId: "fork-request", kind: "fork", text: "Add a visual here" }, "fork-agent");
    await service.journal.bind("token-fork", { agentId: "fork-agent", cwd: dir });
    const current = (await service.store.read("shared"))!;
    const input = join(dir, "fork-publish.json");
    await writeFile(input, JSON.stringify({ boardId: "shared", expectedRevision: current.revision, canvasBase: canvasBase(current), eventId: "fork-visual", patch: { id: "visual", selector: "#target", operation: "append", html: '<svg id="visual"></svg>' }, interactionResult: { id: "fork-request", status: "applied", response: "Added directly", resultReferences: ["#visual"] } }));
    await exec(paths.cli, ["publish", "--file", input], { env: { ...process.env, PASEO_BOARD_BINDING: "token-fork" }, timeout: 5000 });
    expect((await service.store.read("shared"))!).toMatchObject({ ownerAgentId: "owner", canvas: { patches: [{ id: "visual" }] }, interactions: [{ id: "fork-request", status: "applied" }], updates: [{ actorAgentId: "fork-agent", kind: "patch", targets: [{ selector: "#target", patchId: "visual" }] }] });
    expect(await readFile(paths.skill, "utf8")).toContain("carry it out and publish a revision-checked patch directly to this Board");
  });

  it("rejects a CLI writer's stale canvas even with a fresh board revision, preserving the first writer and silent events", async () => {
    const paths = runtimePaths(dir); let next = 0;
    for (const agentId of ["owner", "fork-agent"]) await service.journal.bind(`token-${agentId}`, { agentId, cwd: dir });
    const invoke = async (op: string, value: unknown, agentId = "owner") => {
      const input = join(dir, `concurrent-${++next}.json`); await writeFile(input, JSON.stringify(value));
      const result = await exec(paths.cli, [op, "--file", input], { env: { ...process.env, PASEO_BOARD_BINDING: `token-${agentId}` }, timeout: 5000 });
      return JSON.parse(result.stdout);
    };
    await invoke("create", { id: "concurrent-cli", title: "Shared", html: '<main id="target"><p>Original</p></main>', data: { metrics: { left: 0, right: 0 } } });
    await service.store.addInteraction({ boardId: "concurrent-cli", intentId: "fork-edit", kind: "fork", text: "Edit together" }, "fork-agent");
    const original = await invoke("read", { boardId: "concurrent-cli" });
    expect(original.authoring.canvasBase).toEqual(canvasBase(original));
    const firstPatch = { id: "first-writer", selector: "#target", operation: "append", html: '<p id="preserved">First writer</p>' };
    await invoke("publish", { boardId: original.id, expectedRevision: original.revision, canvasBase: original.authoring.canvasBase, eventId: "first-write", patch: firstPatch });
    const afterFirst = await invoke("read", { boardId: original.id, selector: "#target" });
    expect(afterFirst.authoring).toMatchObject({
      canvasBase: canvasBase(afterFirst), materializedAuthoredHtml: expect.stringContaining('id="preserved"'),
      target: { selector: "#target", html: expect.stringContaining("First writer") },
      replay: { complete: true, appliedPatchIds: ["first-writer"] },
    });
    expect(afterFirst.canvas.html).not.toContain("First writer"); // The read reconstructs authored patches rather than returning the old base as current HTML.
    const stale = { boardId: original.id, expectedRevision: afterFirst.revision, canvasBase: original.authoring.canvasBase };
    await expect(invoke("publish", { ...stale, eventId: "stale-replace", patch: { id: "erase-first", selector: "#target", operation: "replace", html: '<main id="target">Old snapshot edit</main>' } }, "fork-agent")).rejects.toMatchObject({ stderr: expect.stringContaining('"code":"revision_conflict"') });
    await expect(invoke("publish", { ...stale, eventId: "stale-document", html: original.canvas.html, replaceDocument: true }, "fork-agent")).rejects.toMatchObject({ stderr: expect.stringContaining('"code":"revision_conflict"') });
    await expect(invoke("emit", { boardId: original.id, canvasBase: original.authoring.canvasBase, eventId: "stale-event", source: "background", summary: "Old result", data: { metrics: { left: 99, right: 99 } } }, "fork-agent")).rejects.toMatchObject({ stderr: expect.stringContaining('"code":"revision_conflict"') });
    await expect(invoke("emit", { boardId: original.id, eventId: "unguarded-event", source: "background", summary: "Missing baseline", data: { metrics: { left: 99, right: 99 } } }, "fork-agent")).rejects.toThrow();
    expect(await service.store.read(original.id)).toEqual((({ authoring: _authoring, ...board }) => board)(afterFirst));
    await invoke("emit", { boardId: original.id, eventId: "fact-only", source: "background", summary: "Observed without changing the canvas" }, "fork-agent");
    const final = await invoke("read", { boardId: original.id });
    expect(final.canvas).toEqual(afterFirst.canvas); expect(final.updates).toEqual(afterFirst.updates);
    expect(final.events.map((event: { id: string }) => event.id)).toEqual([...afterFirst.events.map((event: { id: string }) => event.id), "fact-only"]);
    expect(final.interactions).toEqual(afterFirst.interactions); // No event wakes an agent or creates an interaction.
  });

  it("preserves two independent CLI data leaves based on the same snapshot and rejects rewriting an already changed leaf", async () => {
    const paths = runtimePaths(dir); let next = 0;
    for (const agentId of ["owner", "fork-agent"]) await service.journal.bind(`token-${agentId}`, { agentId, cwd: dir });
    const invoke = async (op: string, value: unknown, agentId = "owner") => {
      const input = join(dir, `data-${++next}.json`); await writeFile(input, JSON.stringify(value));
      return JSON.parse((await exec(paths.cli, [op, "--file", input], { env: { ...process.env, PASEO_BOARD_BINDING: `token-${agentId}` }, timeout: 5000 })).stdout);
    };
    await invoke("create", { id: "leaves", title: "Shared data", html: '<main id="metrics"></main>', data: { metrics: { left: 0, right: 0 }, preserved: "untouched" } });
    await service.store.addInteraction({ boardId: "leaves", intentId: "fork-data", kind: "fork", text: "Update a different field" }, "fork-agent");
    const original = await invoke("read", { boardId: "leaves" });
    const patch = (path: string, value: number) => [{ path, operation: "set", expected: { exists: true, value: 0 }, value }];
    const common = { boardId: original.id, expectedRevision: original.revision };
    await Promise.all([
      invoke("publish", { ...common, eventId: "left", dataPatch: patch("/metrics/left", 1) }),
      invoke("publish", { ...common, eventId: "right", dataPatch: patch("/metrics/right", 2) }, "fork-agent"),
    ]);
    const both = await invoke("read", { boardId: original.id });
    expect(both.canvas.data).toEqual({ metrics: { left: 1, right: 2 }, preserved: "untouched" });
    expect(both.updates.map((update: { actorAgentId: string }) => update.actorAgentId).sort()).toEqual(["fork-agent", "owner"]);
    await expect(invoke("publish", { ...common, expectedRevision: both.revision, eventId: "rewrite-left", dataPatch: patch("/metrics/left", 3) }, "fork-agent")).rejects.toMatchObject({ stderr: expect.stringContaining('"code":"data_conflict"') });
    const afterConflict = await invoke("read", { boardId: original.id });
    expect(afterConflict.canvas).toEqual(both.canvas); expect(afterConflict.revision).toBe(both.revision);
  });

  it("serves standard stdio MCP messages and binds mutations to the launch identity", async () => {
    const paths = runtimePaths(dir); await service.journal.bind("token-owner", { agentId: "owner", cwd: dir });
    const { call, close } = mcpClient(paths.mcp, "token-owner");
    try {
      expect(await call("initialize", { protocolVersion: "2024-11-05" })).toHaveProperty("result.serverInfo.name", "paseo-board");
      const list = await call("tools/list"); expect((list.result as { tools: unknown[] }).tools).toHaveLength(7);
      const created = await call("tools/call", { name: "board_create", arguments: { id: "bound-board", title: "bound" } }); expect(created).not.toHaveProperty("result.isError", true);
      expect((await service.store.read("bound-board"))!.ownerAgentId).toBe("owner");
      await service.store.addInteraction({ boardId: "bound-board", intentId: "owner-question", kind: "question", text: "Explain" }, "owner");
      const answered = await call("tools/call", { name: "board_respond", arguments: { boardId: "bound-board", interactionId: "owner-question", eventId: "response", expectedResponseRevision: 0, response: "Explicit answer", html: "<canvas></canvas>" } });
      expect(answered).not.toHaveProperty("result.isError", true);
      expect((await service.store.read("bound-board"))!.interactions[0]).toMatchObject({ responseSource: "explicit", response: "Explicit answer" });
      const forbidden = await call("tools/call", { name: "board_create", arguments: { id: "foreign", title: "foreign", ownerAgentId: "someone-else" } }); expect(forbidden).toHaveProperty("result.isError", true);
    } finally { close(); }
  });

  it("enforces the same shared-canvas and per-leaf guards through two bound stdio MCP clients", async () => {
    const paths = runtimePaths(dir);
    for (const agentId of ["owner", "fork-agent"]) await service.journal.bind(`token-${agentId}`, { agentId, cwd: dir });
    const owner = mcpClient(paths.mcp, "token-owner"); const fork = mcpClient(paths.mcp, "token-fork-agent");
    const call = (client: typeof owner, name: string, args: unknown) => client.call("tools/call", { name, arguments: args });
    const expectConflict = (reply: Record<string, unknown>, code: string) => {
      const result = reply.result as { isError: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true); expect(JSON.parse(result.content[0].text)).toHaveProperty("code", code);
    };
    try {
      await Promise.all([owner, fork].map(client => client.call("initialize", { protocolVersion: "2024-11-05" })));
      const definitions = (await owner.call("tools/list")).result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
      const publishSchema = definitions.tools.find(tool => tool.name === "board_publish")!.inputSchema;
      for (const property of ["canvasBase", "replaceDocument", "dataPatch"]) expect(publishSchema.properties).toHaveProperty(property);
      expect(definitions.tools.find(tool => tool.name === "board_read")!.inputSchema.properties).toHaveProperty("selector");
      toolValue(await call(owner, "board_create", { id: "concurrent-mcp", title: "MCP shared", html: '<main id="target">Original</main>', data: { metrics: { left: 0, right: 0 } } }));
      await service.store.addInteraction({ boardId: "concurrent-mcp", intentId: "fork-mcp", kind: "fork", text: "Shared edit" }, "fork-agent");
      const original = toolValue(await call(owner, "board_read", { boardId: "concurrent-mcp" }));
      toolValue(await call(owner, "board_publish", { boardId: original.id, expectedRevision: original.revision, canvasBase: original.authoring.canvasBase, eventId: "mcp-first", patch: { id: "mcp-first", selector: "#target", operation: "append", html: '<p id="mcp-result">Keep this</p>' } }));
      const afterFirst = toolValue(await call(fork, "board_read", { boardId: original.id, selector: "#target" }));
      expect(afterFirst.authoring.target.html).toContain("Keep this"); expect(afterFirst.authoring.replay).toMatchObject({ complete: true, appliedPatchIds: ["mcp-first"] });
      const stale = { boardId: original.id, expectedRevision: afterFirst.revision, canvasBase: original.authoring.canvasBase };
      expectConflict(await call(fork, "board_publish", { ...stale, eventId: "mcp-stale", patch: { id: "mcp-erase", selector: "#target", operation: "replace", html: "<main>Stale</main>" } }), "revision_conflict");
      expectConflict(await call(fork, "board_emit", { boardId: original.id, canvasBase: original.authoring.canvasBase, eventId: "mcp-stale-event", source: "background", summary: "Old data", data: { metrics: { left: 9, right: 9 } } }), "revision_conflict");
      const afterRejections = toolValue(await call(owner, "board_read", { boardId: original.id }));
      expect(afterRejections.canvas).toEqual(afterFirst.canvas); expect(afterRejections.revision).toBe(afterFirst.revision);
      const requests = ["left", "right"].map((leaf, index) => ({ boardId: original.id, expectedRevision: afterFirst.revision, eventId: `mcp-${leaf}`, dataPatch: [{ path: `/metrics/${leaf}`, operation: "set", expected: { exists: true, value: 0 }, value: index + 1 }] }));
      const replies = await Promise.all([call(owner, "board_publish", requests[0]), call(fork, "board_publish", requests[1])]);
      for (const reply of replies) toolValue(reply);
      const afterBoth = toolValue(await call(owner, "board_read", { boardId: original.id }));
      expect(afterBoth.canvas.data).toEqual({ metrics: { left: 1, right: 2 } });
      expect(afterBoth.canvas.patches).toEqual(afterFirst.canvas.patches);
      expectConflict(await call(fork, "board_publish", { ...requests[0], expectedRevision: afterBoth.revision, eventId: "mcp-rewrite-leaf" }), "data_conflict");
      const final = toolValue(await call(owner, "board_read", { boardId: original.id }));
      expect(final.canvas).toEqual(afterBoth.canvas); expect(final.revision).toBe(afterBoth.revision);
      expect(final.updates.map((update: { actorAgentId: string }) => update.actorAgentId).sort()).toEqual(["fork-agent", "owner", "owner"]);
    } finally { owner.close(); fork.close(); }
  });

  it("rejects forged/unbound MCP calls and refuses to replace an active endpoint", async () => {
    const denied = await bridge.dispatch(JSON.stringify({ protocol: 1, operation: "list", input: {}, client: "mcp", binding: "fake" }));
    expect(denied).toHaveProperty("ok", false);
    const second = new BoardBridge(service); await expect(second.start(runtimePaths(dir).socket)).rejects.toThrow("already listening"); await second.close();
    expect(await bridge.dispatch(JSON.stringify({ protocol: 1, operation: "list", input: {}, client: "cli" }))).toHaveProperty("ok", true);
  });

  it("writes a discoverable skill and replaces only its own prompt block", async () => {
    expect(await readFile(runtimePaths(dir).skill, "utf8")).toContain("free canvas is the main product");
    const original = `User instructions\n${boardInstructions("/old/cli", "/old/skill")}\nOther plugin instructions\n`;
    const updated = replaceInstructions(original, boardInstructions("/new/cli", "/new/skill"));
    expect(updated).toContain("User instructions"); expect(updated).toContain("Other plugin instructions"); expect(updated).toContain("/new/cli"); expect(updated).not.toContain("/old/cli");
  });
});

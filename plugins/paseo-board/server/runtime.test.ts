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
    await invoke("publish", { boardId: "cli-board", expectedRevision: 1, eventId: "html1", htmlFile: html });
    const update = { boardId: "cli-board", eventId: "event1", source: "async-shell-test", summary: "New result", data: { result: 42 }, focusSelectors: ["#free"] };
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
    await writeFile(input, JSON.stringify({ boardId: "shared", expectedRevision: current.revision, eventId: "fork-visual", patch: { id: "visual", selector: "#target", operation: "append", html: '<svg id="visual"></svg>' }, interactionResult: { id: "fork-request", status: "applied", response: "Added directly", resultReferences: ["#visual"] } }));
    await exec(paths.cli, ["publish", "--file", input], { env: { ...process.env, PASEO_BOARD_BINDING: "token-fork" }, timeout: 5000 });
    expect((await service.store.read("shared"))!).toMatchObject({ ownerAgentId: "owner", canvas: { patches: [{ id: "visual" }] }, interactions: [{ id: "fork-request", status: "applied" }], updates: [{ actorAgentId: "fork-agent", kind: "patch", targets: [{ selector: "#target", patchId: "visual" }] }] });
    expect(await readFile(paths.skill, "utf8")).toContain("carry it out and publish a revision-checked patch directly to this Board");
  });

  it("serves standard stdio MCP messages and binds mutations to the launch identity", async () => {
    const paths = runtimePaths(dir); await service.journal.bind("token-owner", { agentId: "owner", cwd: dir });
    const child = spawn(paths.mcp, [], { env: { ...process.env, PASEO_BOARD_BINDING: "token-owner" }, stdio: ["pipe", "pipe", "pipe"] });
    let pending = ""; const replies: Array<Record<string, unknown>> = []; const waiting = new Map<number, (value: Record<string, unknown>) => void>();
    child.stdout.on("data", (chunk) => { pending += chunk; for (;;) { const idx = pending.indexOf("\n"); if (idx < 0) break; const line = pending.slice(0, idx); pending = pending.slice(idx + 1); const message = JSON.parse(line); replies.push(message); waiting.get(message.id)?.(message); } });
    let next = 0;
    const call = (method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++next; const timeout = setTimeout(() => reject(new Error("MCP response timed out")), 5000);
      waiting.set(id, (message) => { clearTimeout(timeout); waiting.delete(id); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
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
    } finally { child.kill(); }
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

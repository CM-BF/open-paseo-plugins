import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { setInterval, clearInterval } from "node:timers";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createBoardRpc, emitBoardRpc, interactBoardRpc, listBoardsRpc, publishBoardRpc, readBoardRpc, recordDecisionRpc, saveStateRpc } from "../shared/contracts";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ServiceJournal } from "./journal";
import { BoardBridge } from "./bridge";
import { runtimePaths, writeRuntime, linkSkills } from "./runtime";
import { boardInstructions, replaceInstructions } from "./prompts";
import type { Paseo } from "./sdk";

export interface ContributeOptions { rootDir?: string; runtimeDir?: string; home?: string; linkSkills?: boolean; tickMs?: number; onService?: (service: BoardService) => void }

export function contributeServer(server: PluginServerContext, options: ContributeOptions = {}) {
  const paths = runtimePaths(options.runtimeDir);
  const paseoHome = process.env.PASEO_HOME?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo");
  const root = options.rootDir ?? join(paseoHome, "plugin-data", "paseo-board");
  const store = new BoardStore(root);
  const journal = new ServiceJournal(join(root, "service.json"));
  const log = (message: string) => console.warn(`[paseo-board] ${message}`);
  const service = new BoardService(store, journal, log);
  const bridge = new BoardBridge(service);
  const removers: Array<() => void> = [];
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  options.onService?.(service);
  const ready = (async () => {
    await Promise.all([store.init(), journal.init()]);
    if (stopped) return;
    await writeRuntime(paths);
    if (stopped) return;
    await bridge.start(paths.socket);
    if (stopped) return;
    if (options.linkSkills !== false) await linkSkills(paths, options.home);
    if (stopped) return;
    timer = setInterval(() => { void service.reconcile().catch((error) => log(String(error))); }, options.tickMs ?? 15000);
    (timer as unknown as { unref?: () => void }).unref?.();
  })();
  void ready.catch((error) => log(`startup failed: ${String(error)}`));
  let captured = false;
  const capture = (paseo: Paseo) => {
    service.capture(paseo);
    if (captured) return;
    captured = true;
    void ready.then(() => service.reconcile()).catch((error) => log(String(error)));
  };
  const checkReady = async () => { await ready; if (stopped) throw new Error("Board service stopped"); };

  server.handle(listBoardsRpc, async (input, { paseo }) => { capture(paseo); await checkReady(); return { boards: await store.list(input) }; });
  server.handle(readBoardRpc, async (input, { paseo }) => {
    capture(paseo); await checkReady(); const board = await store.read(input.boardId);
    const unchanged = !!board && board.revision === input.sinceRevision;
    return { board: unchanged ? null : board, unchanged };
  });
  server.handle(createBoardRpc, async (input, { paseo }) => { capture(paseo); await checkReady(); const board = await store.create(input); void service.reconcile(); return board; });
  server.handle(publishBoardRpc, async (input, { paseo }) => { capture(paseo); await checkReady(); return store.publish(input); });
  server.handle(emitBoardRpc, async (input, { paseo }) => { capture(paseo); await checkReady(); return store.emit(input); });
  server.handle(recordDecisionRpc, async (input, { paseo }) => { capture(paseo); await checkReady(); return store.recordDecision(input); });
  server.handle(interactBoardRpc, async (input, { paseo }) => { capture(paseo); await checkReady(); return service.interact(input); });
  server.handle(saveStateRpc, async (input, { paseo }) => { capture(paseo); await checkReady(); await store.saveState(input); return { saved: true }; });

  removers.push(server.before("agent.create", async ({ request }, { paseo }) => {
    capture(paseo);
    try { await checkReady(); } catch (error) { log(`agent.create injection skipped: ${String(error)}`); return; }
    const token = randomBytes(24).toString("hex");
    const original = request.config.systemPrompt ?? "";
    const existing = request.config.mcpServers?.paseo_board;
    const own = existing?.type === "stdio" && existing.command === paths.mcp;
    const family = request.config.provider.split("/")[0];
    const supportsMcp = ["codex", "claude", "opencode"].includes(family);
    const injectMcp = supportsMcp && (!existing || own);
    const servers = { ...request.config.mcpServers };
    if (own && !supportsMcp) delete servers.paseo_board;
    if (injectMcp) servers.paseo_board = { type: "stdio", command: paths.mcp, env: { PASEO_BOARD_BINDING: token } };
    return { ...request, env: { ...request.env, PASEO_BOARD_BINDING: token }, config: { ...request.config,
      systemPrompt: replaceInstructions(original, boardInstructions(paths.cli, paths.skill)),
      ...(injectMcp || own ? { mcpServers: Object.keys(servers).length ? servers : undefined } : {}),
    } };
  }));
  removers.push(server.before("agent.session_open", async ({ request }, { paseo }) => {
    capture(paseo);
    try { await checkReady(); } catch (error) { log(`agent.session_open injection skipped: ${String(error)}`); return; }
    if (request.purpose === "history") return;
    const token = request.env.PASEO_BOARD_BINDING || journal.tokenFor(request.agentId) || randomBytes(24).toString("hex");
    await journal.bind(token, { agentId: request.agentId, cwd: request.cwd, workspaceId: request.workspaceId ?? undefined });
    // 0.13.2 session_open only supports env. MCP injection is on create; resumed agents get CLI.
    return { ...request, env: { ...request.env, PASEO_BOARD_BINDING: token, PASEO_BOARD_HOME: paths.root, PASEO_BOARD_CLI: paths.cli } };
  }));
  removers.push(server.on("agent.turn_ended", async (event, { paseo }) => { capture(paseo); await checkReady(); await service.onTurnEnded(event.agent.id, event.outcome.kind, event.turnId); }));
  removers.push(server.on("agent.archived", async (_event, { paseo }) => { capture(paseo); await checkReady(); await service.reconcile(); }));
  removers.push(server.on("agent.permission_resolved", async (_event, { paseo }) => { capture(paseo); await checkReady(); await service.reconcile(); }));
  return async () => {
    stopped = true;
    for (const remove of removers) remove();
    if (timer) clearInterval(timer);
    // Mark components stopped before awaiting startup; startup may be paused at any await.
    await Promise.all([bridge.close(), service.dispose()]);
    await ready.catch(() => undefined);
    if (timer) clearInterval(timer);
    await bridge.close();
  };
}

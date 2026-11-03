import { BoardStore } from "./store";
import { STORE_METHODS, boardPartition, isComputeMethod, type StoreMethod } from "./store-worker-protocol";

import { buildRelease, releaseZip } from "./static-release";
import { authoredSourceFailure, describeAuthoring } from "./authored-source";
import { ReleaseIdSchema } from "../shared/release-contracts";
import { BoardStoreError } from "./store-format";

let store: BoardStore | undefined;
let initialized = false;
let busy = false;
const send = (message: unknown) => { if (process.connected) process.send?.(message as object); };
process.on("disconnect", () => process.exit(0));
process.on("message", async (message: any) => {
  if (message?.type === "init" && !initialized) {
    initialized = true;
    try {
      store = new BoardStore(message.rootDir, {
        ownsBoard: id => boardPartition(id, message.count) === message.index,
        onCommit: notice => send({ type: "commit", notice }),
      });
      await store.init();
      const summaries = await store.list();
      const canvasRevisions: Record<string, number> = {};
      if (message.recover) for (const summary of summaries) {
        const board = await store.read(summary.id);
        if (board) canvasRevisions[summary.id] = board.canvas.revision;
      }
      send({ type: "ready", summaries, canvasRevisions });
    } catch (error) { send({ type: "startup-error", error: serializeError(error) }); }
    return;
  }
  if (message?.type !== "call" || !store) return;
  const { id, method, args } = message;
  if (busy || (!STORE_METHODS.includes(method) && !isComputeMethod(method)) || !Array.isArray(args)) {
    send({ type: "result", id, error: { code: "worker_protocol", message: "Invalid or concurrent store request", details: {} } });
    return;
  }
  busy = true;
  try {
    let value: unknown;
    if (method === "buildRelease") value = buildRelease(args[0]);
    else if (method === "releaseZip") {
      ReleaseIdSchema.parse(args[0]);
      const files = args[1];
      if (!files || typeof files !== "object" || Array.isArray(files) || Object.values(files).some(item => typeof item !== "string")) throw new BoardStoreError("invalid_input", "Release ZIP files must be a string map");
      value = releaseZip(files).toString("base64");
    } else if (method === "materializeAuthoredHtml") {
      const authored = describeAuthoring(args[1]);
      if (!authored.replay.complete || authored.materializedAuthoredHtml === null) throw new BoardStoreError("edit_conflict", authoredSourceFailure("Cannot materialize current authored source", authored));
      value = authored.materializedAuthoredHtml;
    } else {
      const operation = store[method as StoreMethod] as (...input: any[]) => Promise<unknown>;
      value = await operation.apply(store, args);
    }
    send({ type: "result", id, value });
  } catch (error) { send({ type: "result", id, error: serializeError(error) }); }
  finally { busy = false; }
});

function serializeError(error: unknown) {
  const failure = error as { code?: string; message?: string; details?: Record<string, unknown> };
  return { code: failure?.code ?? "request_failed", message: failure?.message ?? String(error), details: failure?.details ?? {} };
}

import { createHash } from "node:crypto";
import { readFile, open, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CreateInputSchema, type Board } from "../shared/contracts";
import { CopyBoardInputSchema, type CopyBoardInput } from "../shared/board-copy";
import { authoredSourceFailure, describeAuthoring } from "./authored-source";
import { BoardStoreError, canonicalJson, ensureDirectory, serialized } from "./store-format";

const ReceiptSchema = z.object({ input: CopyBoardInputSchema, create: CreateInputSchema });
interface CopyStore { read(id: string): Promise<Board | null>; create(input: z.input<typeof CreateInputSchema>): Promise<Board> }
type CopyMaterializer = (source: Board) => Promise<string>;
const materializeLocally: CopyMaterializer = async source => {
  const authoring = describeAuthoring(source.canvas);
  if (!authoring.replay.complete || authoring.materializedAuthoredHtml === null) throw new BoardStoreError("edit_conflict", authoredSourceFailure("Cannot copy current authored source", authoring));
  return authoring.materializedAuthoredHtml;
};

/** Keeps the exact source frozen before creation, including across response loss. */
export class BoardCopies {
  private readonly directory: string;
  private readonly store: CopyStore;
  constructor(directory: string, store: CopyStore, private readonly materialize: CopyMaterializer = materializeLocally) { this.directory = directory; this.store = store; }
  async copy(raw: CopyBoardInput): Promise<Board> {
    const input = CopyBoardInputSchema.parse(raw);
    const key = createHash("sha256").update(input.eventId).digest("hex");
    const path = join(this.directory, `${key}.json`);
    await ensureDirectory(this.directory);
    return serialized(path, async () => {
      let receipt: z.infer<typeof ReceiptSchema> | undefined;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12_000_000) throw new Error("Invalid Board copy receipt");
        receipt = ReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (receipt && canonicalJson(receipt.input) !== canonicalJson(input)) throw new BoardStoreError("idempotency_conflict", "This copy request already names a different source or title");
      if (!receipt) {
        const source = await this.store.read(input.boardId);
        if (!source) throw new BoardStoreError("not_found", "Source Board does not exist");
        if (source.canvas.revision !== input.canvasBase.revision || source.canvas.documentVersion !== input.canvasBase.documentVersion) throw new BoardStoreError("revision_conflict", "The source canvas changed; review it before copying");
        const html = await this.materialize(source);
        receipt = { input, create: CreateInputSchema.parse({
          id: `copy-${key.slice(0, 40)}`, title: input.title, html,
          data: source.canvas.data, ownerAgentId: source.ownerAgentId,
          projectId: source.projectId, workspaceId: source.workspaceId,
        }) };
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(canonicalJson(receipt)); await file.sync(); } finally { await file.close(); }
      }
      // create replays its original receipt and returns current manual edits.
      // It also rejects an unrelated Board that already occupies the target ID.
      return this.store.create(receipt.create);
    });
  }
}

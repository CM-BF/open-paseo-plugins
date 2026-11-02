import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BoardSchema, CanvasBaseSchema, IdSchema } from "./contracts";

export const CopyBoardInputSchema = z.object({
  boardId: IdSchema, canvasBase: CanvasBaseSchema, eventId: IdSchema,
  title: z.string().trim().min(1).max(200),
});
export type CopyBoardInput = z.infer<typeof CopyBoardInputSchema>;
export const copyBoardRpc = defineRpc({ name: "board.copy", input: CopyBoardInputSchema, output: BoardSchema });

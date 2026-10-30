import { describe, expect, it } from "vitest";
import type { Board } from "../shared/contracts";
import { mergeBoardSnapshot } from "./board-cache";
const board = (revision: number, seenUpdateIds: string[], updates = ["a", "b"]): Board => ({ id: "board", revision, title: `r${revision}`, seenUpdateIds, updates: updates.map(id => ({ id })) }) as Board;
describe("independent seen receipts", () => {
  it("preserves seen acknowledgements across an older in-flight read with the same content revision", () => {
    expect(mergeBoardSnapshot(board(3, ["b"]), board(3, []))).toMatchObject({ revision: 3, seenUpdateIds: ["b"] });
  });
  it("accepts a late seen receipt without reverting concurrent newer canvas content", () => {
    expect(mergeBoardSnapshot(board(4, ["b"]), board(3, ["a"]))).toMatchObject({ revision: 4, title: "r4", seenUpdateIds: ["b", "a"] });
  });
  it("prunes receipts outside the current bounded window", () => {
    expect(mergeBoardSnapshot(board(3, ["a"]), board(4, [], ["b"])).seenUpdateIds).toEqual([]);
  });
  it("never transfers receipts across Board identities", () => {
    expect(mergeBoardSnapshot(board(3, ["a"]), { ...board(1, []), id: "other" }).seenUpdateIds).toEqual([]);
  });
});

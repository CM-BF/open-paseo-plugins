import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { EditResultSchema, type EditInput } from "../shared/contracts";
import { componentIdentityFor } from "../shared/component-identity";
import { ComponentEditWriter } from "../client/component-edit-writer";
import { editBoardResult } from "./component-edit-rpc";
import { BoardStore, BoardStoreError } from "./store";

describe("component edit RPC outcomes", () => {
  it("carries an actual authored-source refusal through JSON without losing its code to handler_error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "board-edit-rpc-"));
    try {
      const store = new BoardStore(dir);
      const html = '<main id="root"><p>original</p><section id="destination"></section></main>';
      const before = await store.create({ id: "board", title: "RPC fixture", ownerAgentId: "owner", html });
      const document = new DOMParser().parseFromString(html, "text/html");
      const source = componentIdentityFor(document.querySelector("p")!);
      const request = {
        canvasBase: { revision: before.canvas.revision, documentVersion: before.canvas.documentVersion },
        patch: { operation: "text" as const, selector: "#root > p", sourceIdentity: { ...source, authoredHtml: "<p>runtime changed</p>" }, expectedText: "runtime changed", text: "retained draft" },
      };
      const writer = new ComponentEditWriter(), pending = writer.propose("board", request, "native-edit");
      let response: unknown;
      // The public host validates JSON RPC data. Only thrown failures are flattened
      // into generic handler_error; the domain refusal now takes the data path.
      await writer.save(async input => {
        response = JSON.parse(JSON.stringify(await editBoardResult(store, input)));
        return EditResultSchema.parse(response);
      }, vi.fn(), async () => undefined);
      expect(response).toMatchObject({ status: "rejected", eventId: "native-edit", code: "edit_conflict" });
      expect((await pending).status).toBe("rejected");
      expect(writer.snapshot()).toMatchObject({ status: "rejected", request: { patch: { text: "retained draft" } } });
      expect(await store.read("board")).toEqual(before);
      writer.cancel(); expect(writer.snapshot()).toBeNull();

      const valid: EditInput = { ...request, boardId: "board", eventId: "accepted-edit", patch: { ...request.patch, id: "accepted-edit", sourceIdentity: source, expectedText: "original" } };
      expect(EditResultSchema.parse(await editBoardResult(store, { ...valid, expectedCreatedAt: "old-entity" }))).toEqual({ status: "rejected", eventId: valid.eventId, code: "board_identity_changed" });
      expect(await store.read("board")).toEqual(before);
      const applied = EditResultSchema.parse(await editBoardResult(store, valid));
      expect(applied).toMatchObject({ status: "applied", eventId: "accepted-edit", board: { canvas: { revision: 2 } } });
      expect(EditResultSchema.parse(await editBoardResult(store, valid))).toEqual(applied);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rethrows unknown worker and I/O failures even if their messages look like a refusal", async () => {
    const request = { boardId: "a", eventId: "retry" } as EditInput;
    for (const error of [
      new BoardStoreError("outcome_unknown", "Anonymous component no longer matches its authored source; select it again"),
      new BoardStoreError("worker_unavailable", "worker stopped"),
      new Error("post-rename fsync failed"),
      Object.assign(new Error("forged domain error"), { code: "edit_conflict" }),
    ]) {
      const store = { edit: async () => { throw error; } };
      await expect(editBoardResult(store, request)).rejects.toBe(error);
    }
  });
});

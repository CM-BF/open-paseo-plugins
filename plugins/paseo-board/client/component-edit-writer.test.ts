import { describe, expect, it, vi } from "vitest";
import type { Board, EditInput, EditResult } from "../shared/contracts";
import type { ComponentEditRequest } from "../shared/frame-contract";
import { ComponentEditWriter } from "./component-edit-writer";
const proposal = (): ComponentEditRequest => ({ canvasBase: { revision: 4, documentVersion: 2 }, patch: { operation: "text", selector: "#label", sourceIdentity: { tag: "p", id: "label", fingerprint: "abcd1234" }, expectedText: "old", text: "new" } });
const board = (revision = 5) => ({ id: "a", canvas: { revision } }) as Board;
const applied = (revision = 5, eventId = "host-event"): EditResult => ({ status: "applied", eventId, board: board(revision) });
const refresh = vi.fn(async () => undefined);
describe("host-owned component saves", () => {
  it("keeps source identity through an unknown save and treats replacement as a confirmed refusal", async () => {
    const writer = new ComponentEditWriter(), outcome = writer.propose("a", proposal(), "entity-event", "original-entity");
    const first = vi.fn(async (_request: EditInput): Promise<EditResult> => { throw new Error("lost reply"); });
    await writer.save(first, vi.fn(), refresh);
    const accept = vi.fn(), retry = vi.fn(async (_request: EditInput): Promise<EditResult> => ({ status: "rejected", eventId: "entity-event", code: "board_identity_changed" }));
    await writer.save(retry, accept, refresh);
    expect(retry.mock.calls[0][0]).toBe(first.mock.calls[0][0]);
    expect(retry.mock.calls[0][0].expectedCreatedAt).toBe("original-entity");
    expect(await outcome).toMatchObject({ status: "rejected" }); expect(accept).not.toHaveBeenCalled();
    writer.cancel(); expect(writer.snapshot()).toBeNull();
  });
  it("stages without saving, snapshots caller input and cancels without a mutation", async () => {
    const writer = new ComponentEditWriter(), input = proposal();
    const result = writer.propose("a", input, "host-event");
    input.patch.text = "changed by caller"; input.canvasBase.revision = 99;
    expect(writer.snapshot()?.request).toMatchObject({ boardId: "a", eventId: "host-event", canvasBase: { revision: 4 }, patch: { id: "host-event", text: "new" } });
    writer.cancel(); expect(await result).toEqual({ status: "cancelled" }); expect(writer.snapshot()).toBeNull();
  });
  it("uses host-owned IDs and permits editing text only before the first save", async () => {
    const writer = new ComponentEditWriter(); const result = writer.propose("a", proposal(), "host-event");
    writer.editText("final");
    const send = vi.fn(async (_input: EditInput) => applied()); const accept = vi.fn();
    await writer.save(send, accept, refresh);
    expect(send.mock.calls[0][0].patch.text).toBe("final"); expect(accept).toHaveBeenCalledOnce();
    expect(await result).toEqual({ status: "applied", canvasRevision: 5 });
  });
  it("rejects a changed canvas instead of silently rebasing the proposal", async () => {
    const writer = new ComponentEditWriter(), result = writer.propose("a", proposal(), "host-event");
    writer.invalidate({ revision: 4, documentVersion: 2 }); expect(writer.snapshot()?.status).toBe("review");
    writer.invalidate({ revision: 5, documentVersion: 2 });
    const send = vi.fn(); await writer.save(send, vi.fn(), refresh);
    expect(send).not.toHaveBeenCalled(); expect((await result).status).toBe("rejected"); expect(writer.snapshot()?.request.canvasBase.revision).toBe(4);
  });
  it("single-flights saves and preserves the immutable request after an unknown outcome", async () => {
    const writer = new ComponentEditWriter(), result = writer.propose("a", proposal(), "host-event");
    let fail!: (e: Error) => void;
    const send = vi.fn((_input: EditInput) => new Promise<EditResult>((_resolve, reject) => { fail = reject; }));
    const flight = writer.save(send, vi.fn(), refresh); await writer.save(send, vi.fn(), refresh);
    expect(send).toHaveBeenCalledOnce(); const first = send.mock.calls[0][0];
    fail(new Error("response lost")); await flight;
    writer.cancel(); writer.editText("cannot replace ambiguous write"); writer.invalidate({ revision: 6, documentVersion: 3 });
    expect(writer.snapshot()?.status).toBe("unknown"); expect(writer.snapshot()?.request).toBe(first);
    expect((await writer.propose("a", proposal(), "other-event")).status).toBe("rejected");
    const retry = vi.fn(async (_input: EditInput) => applied(6)); await writer.save(retry, vi.fn(), refresh);
    expect(retry.mock.calls[0][0]).toBe(first); expect((await result).status).toBe("applied");
  });
  it("releases a confirmed server refusal without treating it as an unknown commit", async () => {
    const writer = new ComponentEditWriter(), result = writer.propose("a", proposal(), "host-event");
    await writer.save(async () => ({ status: "rejected", eventId: "host-event", code: "revision_conflict" }), vi.fn(), refresh);
    expect(writer.snapshot()?.status).toBe("rejected"); expect((await result).status).toBe("rejected");
    writer.cancel(); expect(writer.snapshot()).toBeNull();
  });
  it("allows cancelling when the Board disappeared before the server could execute the save", async () => {
    const writer = new ComponentEditWriter(), result = writer.propose("removed-board", proposal(), "missing-board-save");
    const commit = vi.fn(async (_input: EditInput): Promise<EditResult> => ({ status: "rejected", eventId: "missing-board-save", code: "not_found" }));
    const accept = vi.fn();
    await writer.save(commit, accept, refresh);
    expect(writer.snapshot()?.status).toBe("rejected");
    expect(await result).toMatchObject({ status: "rejected", message: expect.stringContaining("修改未保存") });
    expect(accept).not.toHaveBeenCalled();
    // A confirmed missing Board is not an ambiguous write: it must not lock cancellation
    // or let the rejected save issue another request while the user closes the notice.
    await writer.save(commit, accept, refresh);
    expect(commit).toHaveBeenCalledOnce();
    writer.cancel(); expect(writer.snapshot()).toBeNull();
  });
  it("generates copy prefixes from the host receipt and never accepts caller-owned IDs", async () => {
    const writer = new ComponentEditWriter();
    const request: ComponentEditRequest = { canvasBase: { revision: 4, documentVersion: 2 }, patch: { operation: "copy", selector: "#label", sourceIdentity: { tag: "p", id: "label", fingerprint: "abcd1234" }, destination: "#container", destinationIdentity: { tag: "div", id: "container", fingerprint: "abcd5678" }, position: "append" } };
    const result = writer.propose("a", request, "host-copy-event");
    expect(writer.snapshot()?.request.patch).toMatchObject({ id: "host-copy-event", copyIdPrefix: "host-copy-event" }); writer.cancel(); await result;
  });
  it("retains edited text on a typed refusal and releases cancellation without another request", async () => {
    const writer = new ComponentEditWriter(), result = writer.propose("a", proposal(), "host-event");
    writer.editText("用户在保存卡中修改的草稿");
    const commit = vi.fn(async (): Promise<EditResult> => ({ status: "rejected", eventId: "host-event", code: "edit_conflict" }));
    await writer.save(commit, vi.fn(), refresh);
    expect(await result).toMatchObject({ status: "rejected" });
    expect(writer.snapshot()).toMatchObject({ status: "rejected", request: { patch: { text: "用户在保存卡中修改的草稿" } } });
    await writer.save(commit, vi.fn(), refresh); expect(commit).toHaveBeenCalledOnce();
    writer.cancel(); expect(writer.snapshot()).toBeNull();
    const next = writer.propose("a", proposal(), "new-event");
    expect(writer.snapshot()?.status).toBe("review"); writer.cancel(); await next;
  });
  it("never treats Paseo handler_error text or an unrelated typed receipt as proof of rejection", async () => {
    const failures = [
      Object.assign(new Error("Request failed: Anonymous component no longer matches its authored source; select it again requestType=plugin.rpc.invoke.request code=handler_error"), { requestType: "plugin.rpc.invoke.request", code: "handler_error" }),
      Object.assign(new Error("post-commit failure"), { code: "edit_conflict" }),
    ];
    for (const error of failures) {
      const writer = new ComponentEditWriter(), result = writer.propose("a", proposal(), "host-event");
      const first = writer.snapshot()!.request;
      await writer.save(async () => { throw error; }, vi.fn(), refresh);
      writer.cancel(); expect(writer.snapshot()?.status).toBe("unknown");
      expect(writer.snapshot()?.error).not.toMatch(/handler_error|Anonymous|requestType/);
      await writer.save(async () => ({ status: "rejected", eventId: "another-event", code: "edit_conflict" }), vi.fn(), refresh);
      expect(writer.snapshot()?.status).toBe("unknown"); expect(writer.snapshot()?.request).toBe(first);
      await writer.save(async () => applied(), vi.fn(), refresh); expect((await result).status).toBe("applied");
    }
  });
  it("identifies a changed destination separately from the component being moved", async () => {
    const writer = new ComponentEditWriter(), pending = writer.propose("a", proposal(), "host-event");
    await writer.save(async () => ({ status: "rejected", eventId: "host-event", code: "edit_conflict", componentTarget: "destination" }), vi.fn(), refresh);
    expect(await pending).toMatchObject({ status: "rejected", message: expect.stringContaining("目标容器") });
    expect(writer.snapshot()?.error).toContain("重新选择目标"); writer.cancel();
  });
  it("keeps a layout configuration and its original canvas base immutable across a lost save response", async () => {
    const writer = new ComponentEditWriter();
    const input: ComponentEditRequest = {
      canvasBase: { revision: 4, documentVersion: 2 },
      patch: { operation: "layout", selector: "#card", sourceIdentity: { tag: "article", id: "card", fingerprint: "abcd1234" },
        layout: { collapse: "group", title: "实验记录", maxHeight: 320 } },
    };
    const pending = writer.propose("a", input, "host-layout-event");
    input.patch.layout!.maxHeight = 800;
    input.patch.layout!.title = "后来输入的标题";
    const frozen = writer.snapshot()!.request;
    await writer.save(async () => { throw new Error("response lost after commit"); }, vi.fn(), refresh);
    writer.cancel(); writer.invalidate({ revision: 5, documentVersion: 2 });
    expect(writer.snapshot()).toMatchObject({ status: "unknown", request: {
      canvasBase: { revision: 4, documentVersion: 2 }, patch: { id: "host-layout-event", layout: { collapse: "group", title: "实验记录", maxHeight: 320 } },
    } });
    const retry = vi.fn(async (_input: EditInput) => applied(5, "host-layout-event"));
    await writer.save(retry, vi.fn(), refresh);
    expect(retry.mock.calls[0][0]).toBe(frozen);
    expect(await pending).toEqual({ status: "applied", canvasRevision: 5 });
  });
});

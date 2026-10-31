import { describe, expect, it, vi } from "vitest";
import type { Board, EditInput } from "../shared/contracts";
import type { ComponentEditRequest } from "../shared/frame-contract";
import { ComponentEditWriter } from "./component-edit-writer";
const proposal = (): ComponentEditRequest => ({ canvasBase: { revision: 4, documentVersion: 2 }, patch: { operation: "text", selector: "#label", sourceIdentity: { tag: "p", id: "label", fingerprint: "abcd1234" }, expectedText: "old", text: "new" } });
const board = (revision = 5) => ({ canvas: { revision } }) as Board;
const refresh = vi.fn(async () => undefined);
describe("host-owned component saves", () => {
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
    const send = vi.fn(async (_input: EditInput) => board()); const accept = vi.fn();
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
    const send = vi.fn((_input: EditInput) => new Promise<Board>((_resolve, reject) => { fail = reject; }));
    const flight = writer.save(send, vi.fn(), refresh); await writer.save(send, vi.fn(), refresh);
    expect(send).toHaveBeenCalledOnce(); const first = send.mock.calls[0][0];
    fail(new Error("response lost")); await flight;
    writer.cancel(); writer.editText("cannot replace ambiguous write"); writer.invalidate({ revision: 6, documentVersion: 3 });
    expect(writer.snapshot()?.status).toBe("unknown"); expect(writer.snapshot()?.request).toBe(first);
    expect((await writer.propose("a", proposal(), "other-event")).status).toBe("rejected");
    const retry = vi.fn(async (_input: EditInput) => board(6)); await writer.save(retry, vi.fn(), refresh);
    expect(retry.mock.calls[0][0]).toBe(first); expect((await result).status).toBe("applied");
  });
  it("releases a confirmed server refusal without treating it as an unknown commit", async () => {
    const writer = new ComponentEditWriter(), result = writer.propose("a", proposal(), "host-event");
    await writer.save(async () => { throw Object.assign(new Error("stale"), { code: "revision_conflict" }); }, vi.fn(), refresh);
    expect(writer.snapshot()?.status).toBe("rejected"); expect((await result).status).toBe("rejected");
    writer.cancel(); expect(writer.snapshot()).toBeNull();
  });
  it("generates copy prefixes from the host receipt and never accepts caller-owned IDs", async () => {
    const writer = new ComponentEditWriter();
    const request: ComponentEditRequest = { canvasBase: { revision: 4, documentVersion: 2 }, patch: { operation: "copy", selector: "#label", sourceIdentity: { tag: "p", id: "label", fingerprint: "abcd1234" }, destination: "#container", destinationIdentity: { tag: "div", id: "container", fingerprint: "abcd5678" }, position: "append" } };
    const result = writer.propose("a", request, "host-copy-event");
    expect(writer.snapshot()?.request.patch).toMatchObject({ id: "host-copy-event", copyIdPrefix: "host-copy-event" }); writer.cancel(); await result;
  });
});

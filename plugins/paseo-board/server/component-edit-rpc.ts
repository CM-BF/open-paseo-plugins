import { EditRefusalCodeSchema, type EditInput, type EditResult } from "../shared/contracts";
import type { BoardStoreApi } from "./store";
import { BoardStoreError } from "./store-format";

/** Domain refusals are RPC data: Paseo's generic handler_error loses custom error codes. */
export async function editBoardResult(store: Pick<BoardStoreApi, "edit">, input: EditInput): Promise<EditResult> {
  try {
    return { status: "applied", eventId: input.eventId, board: await store.edit(input) };
  } catch (error) {
    // These checks happen before durable mutation. Worker exits, timeouts, I/O
    // failures and post-commit response loss must still retain the exact retry.
    const code = error instanceof BoardStoreError ? EditRefusalCodeSchema.safeParse(error.code) : undefined;
    if (code?.success && error instanceof BoardStoreError) {
      const target = error.details.componentTarget;
      return { status: "rejected", eventId: input.eventId, code: code.data,
        ...(target === "source" || target === "destination" ? { componentTarget: target } : {}) };
    }
    throw error;
  }
}

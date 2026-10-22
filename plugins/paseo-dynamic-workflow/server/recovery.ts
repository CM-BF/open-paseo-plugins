import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { LABEL_CALL, LABEL_RUN } from "../shared/ids";
import type { PaseoApi } from "./gate";
import type { RunRecord } from "./run-store";
import { describeError, log } from "./util";

const exec = promisify(execFile);
const BASE_LABEL = "paseo-dynamic-workflow/base";

/** Find children by daemon ownership as well as persisted ids, including a lost create response. */
export async function recoverChildren(paseo: PaseoApi, record: RunRecord): Promise<void> {
  const ids = new Set(record.calls.flatMap((call) => call.agentId ? [call.agentId] : []));
  let cursor: string | undefined;
  try { do {
    const page = await paseo.agents.list({
      filter: { labels: { [LABEL_RUN]: record.runId }, includeArchived: false, includeBackground: true },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of page.entries) ids.add(agent.id);
    const next = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    if (next === cursor) break;
    cursor = next;
  } while (cursor); } catch (error) {
    log(`could not list leftover children of ${record.runId}: ${describeError(error)}`);
  }

  for (const id of ids) {
    try {
      const handle = paseo.agents.ref(id);
      const fresh = await handle.refresh();
      if (!fresh || fresh.agent.labels?.[LABEL_RUN] !== record.runId) continue;
      const agent = fresh.agent;
      const call = record.calls.find((entry) => entry.callId === agent.labels?.[LABEL_CALL] || entry.agentId === id);
      if (call) call.agentId = id;
      if (!agent.archivedAt) await handle.archive();
      const base = agent.labels?.[BASE_LABEL];
      if (!base || !/^[0-9a-f]{40,64}$/.test(base) || !agent.workspaceId || agent.workspaceId === record.workspaceId || resolve(agent.cwd) === resolve(record.cwd)) continue;
      const git = async (...args: string[]) => (await exec("git", ["-C", agent.cwd, ...args], { timeout: 5000 })).stdout.trim();
      const branch = await git("branch", "--show-current");
      const dirty = await git("status", "--porcelain");
      const head = await git("rev-parse", "HEAD");
      const worktree = { path: agent.cwd, branch: branch || null, workspaceId: agent.workspaceId, changed: dirty !== "" || head !== base };
      if (call) call.worktree = worktree;
      if (!worktree.changed) {
        const result = await paseo.workspaces.archive(agent.workspaceId);
        if (result.error) {
          if (call?.worktree) call.worktree.changed = null;
          throw new Error(result.error);
        }
        const remains = await stat(agent.cwd).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (remains) {
          if (call?.worktree) call.worktree.changed = null;
          throw new Error("the workspace was archived but its worktree directory still exists");
        }
      }
    } catch (error) {
      log(`could not recover child ${id} of ${record.runId}: ${describeError(error)}`);
    }
  }
}

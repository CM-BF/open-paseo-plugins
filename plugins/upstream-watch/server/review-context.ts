import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { revisionSchema, type Watch } from "../shared/contracts";

const exec = promisify(execFile);
export async function localRevision(targetPath: string): Promise<string> {
  try {
    const result = await exec(
      "git",
      ["-C", targetPath, "rev-parse", "--verify", "HEAD"],
      {
        timeout: 5000,
        maxBuffer: 4096,
        windowsHide: true,
      },
    );
    return revisionSchema.parse(result.stdout.trim()).toLowerCase();
  } catch {
    throw new Error(
      "无法读取本地 Git revision；请确认目标目录属于有提交的源码仓库后重试。",
    );
  }
}
export function reviewKey(watch: Watch, localRevision?: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        repository: watch.repository,
        baseline: watch.baseline,
        head: watch.observation?.head,
        targetPath: watch.targetPath,
        workspaceId: watch.workspaceId,
        provider: watch.provider,
        localRevision,
        features: watch.review?.features,
        notes: watch.notes,
        paths: watch.paths,
      }),
    )
    .digest("hex");
}

/** Development may move HEAD; the fixed reviewed commit must remain readable. */
export async function verifyLocalRevision(targetPath: string, revision: string): Promise<void> {
  const expected = revisionSchema.parse(revision).toLowerCase();
  try {
    const result = await exec('git', ['-C', targetPath, 'rev-parse', '--verify', `${expected}^{commit}`], { timeout: 5000, maxBuffer: 4096, windowsHide: true });
    if (result.stdout.trim().toLowerCase() !== expected) throw new Error('Commit mismatch');
  } catch { throw new Error('无法读取建议固定的本地 Git commit；没有创建建议 agent。'); }
}

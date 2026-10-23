import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { reloadAgent } from "./reload";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fakeCli(exitCode: number) {
  const dir = await mkdtemp(join(tmpdir(), "dwf-reload-"));
  dirs.push(dir);
  const cli = join(dir, "paseo");
  await writeFile(cli, `#!/bin/sh\necho "$@" > "${dir}/args"\n[ ${exitCode} -eq 0 ] || echo "agent not found" >&2\nexit ${exitCode}\n`);
  await chmod(cli, 0o755);
  return { cli, args: () => readFile(join(dir, "args"), "utf8") };
}

it("reloads through the Paseo CLI and reports failures without throwing", async () => {
  const good = await fakeCli(0);
  expect(await reloadAgent("agent-a", good.cli)).toMatchObject({ reloaded: true });
  expect(await good.args()).toMatch(/^agent reload agent-a --json --home /);
  const bad = await fakeCli(3);
  expect(await reloadAgent("agent-a", bad.cli)).toMatchObject({ reloaded: false, message: expect.stringMatching(/Could not reload: .*Reload the agent from its menu/) });
  expect(await reloadAgent("agent-a", null)).toMatchObject({ reloaded: false, message: expect.stringContaining("CLI was not found") });
});

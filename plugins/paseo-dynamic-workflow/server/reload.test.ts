import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { reloadAgent } from "./reload";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

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
  expect(await reloadAgent("agent-a", bad.cli)).toMatchObject({ reloaded: false, message: expect.stringContaining("agent not found") });
  expect(await reloadAgent("agent-a", null)).toMatchObject({ reloaded: false, message: expect.stringContaining("CLI was not found") });
});

it("uses the CLI supplied by the daemon instead of a platform-specific installation", async () => {
  const good = await fakeCli(0);
  const legacy = await fakeCli(3);
  vi.stubEnv("PASEO_CLI", good.cli);
  vi.stubEnv("PASEO_BIN", legacy.cli);
  expect(await reloadAgent("agent-from-daemon")).toMatchObject({ reloaded: true });
  expect(await good.args()).toContain("agent reload agent-from-daemon --json --home ");
});

it("ends a stalled CLI and reports its outcome as unknown before the RPC expires", async () => {
  const f = await fakeCli(0);
  await writeFile(f.cli, "#!/bin/sh\nwhile :; do :; done\n");
  const began = Date.now();
  // A short deadline exercises the same child-process cancellation used by the real RPC.
  expect(await reloadAgent("agent-a", f.cli, 40)).toMatchObject({ reloaded: false, message: expect.stringMatching(/timed out.*check the agent/i) });
  expect(Date.now() - began).toBeLessThan(2000);
});

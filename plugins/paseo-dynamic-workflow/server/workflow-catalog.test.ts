import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BUILTIN_WORKFLOWS } from "./builtin-workflows";
import { catalogText, findNamedWorkflow, listWorkflows, UnknownWorkflowError } from "./workflow-catalog";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function savedDir(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "dwf-catalog-"));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}
const script = (name: string, when?: string) => `export const meta = { name: '${name}', description: 'mine'${when ? `, whenToUse: '${when}'` : ""} }\nreturn 1`;

it("lets a saved file replace a built-in, while builtin.<name> always reaches the shipped one", async () => {
  const dir = await savedDir({ "deep-review.js": script("deep-review"), "mine.js": script("mine", "for me"), "broken.js": "nope" });
  expect((await findNamedWorkflow("deep-review", [dir])).path).toBe(join(dir, "deep-review.js"));
  expect(await findNamedWorkflow("builtin.deep-review", [dir])).toEqual({ script: BUILTIN_WORKFLOWS["deep-review"], path: null });
  expect(await findNamedWorkflow("deep-research", [dir])).toEqual({ script: BUILTIN_WORKFLOWS["deep-research"], path: null });
  await expect(findNamedWorkflow("builtin.mine", [dir])).rejects.toBeInstanceOf(UnknownWorkflowError);
  await expect(findNamedWorkflow("absent", [dir])).rejects.toThrow(/Available: .*deep-research.*mine/);

  const entries = await listWorkflows([dir]);
  expect(entries.find((e) => e.name === "deep-review")).toMatchObject({ source: join(dir, "deep-review.js"), description: "mine" });
  expect(entries.find((e) => e.name === "design-panel")).toMatchObject({ source: "built-in" });
  expect(entries.find((e) => e.name === "broken")?.description).toMatch(/does not parse/);
  const text = catalogText(entries, "/state/workflows");
  expect(text).toContain("`mine` (" + join(dir, "mine.js") + "): mine When to use: for me");
  expect(text).toContain("`verify-claims` (built-in, source /state/workflows/verify-claims.js)");
});

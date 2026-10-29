import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../server/store";

const roots: string[] = [];
async function fixture(): Promise<{ path: string; store: Store }> {
  const root = await mkdtemp(join(tmpdir(), "upstream-store-"));
  roots.push(root);
  const path = join(root, "state.json");
  return { path, store: new Store(path) };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("Store", () => {
  it("starts with daily checks, returns clones, and restores persisted data", async () => {
    const { path, store } = await fixture();
    const first = await store.read();
    first.settings.enabled = false;
    expect((await store.read()).settings).toEqual({
      enabled: true,
      intervalHours: 24,
    });
    await store.change((state) => {
      state.settings.intervalHours = 12;
    });
    expect((await new Store(path).read()).settings.intervalHours).toBe(12);
  });
  it("serializes concurrent mutations and survives a rejected mutation", async () => {
    const { store } = await fixture();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.change(async (state) => {
          await Promise.resolve();
          state.settings.intervalHours++;
        }),
      ),
    );
    expect((await store.read()).settings.intervalHours).toBe(34);
    await expect(
      store.change((state) => {
        state.settings.intervalHours = 0;
      }),
    ).rejects.toThrow();
    await store.change((state) => {
      state.settings.intervalHours = 24;
    });
    expect((await store.read()).settings.intervalHours).toBe(24);
  });
  it("preserves invalid JSON instead of silently replacing it", async () => {
    const { path } = await fixture();
    await writeFile(path, "{broken");
    const broken = new Store(path);
    await expect(broken.read()).rejects.toThrow("original file was preserved");
    await expect(
      broken.change((state) => {
        state.settings.enabled = false;
      }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
});

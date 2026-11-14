import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv, routeFrom } from "./complete";

/** server/kit/complete.ts is a verbatim copy of plugins/learning-loop/server/kit/complete.ts (the kit rule in its header). */
describe("kit copy", () => {
  it("is byte-identical to the learning-loop kit when both are in the repository", () => {
    const own = readFileSync(join(__dirname, "complete.ts"));
    const source = join(__dirname, "..", "..", "..", "learning-loop", "server", "kit", "complete.ts");
    if (!existsSync(source)) return; // An installed plugin directory stands alone.
    expect(own.equals(readFileSync(source))).toBe(true);
  });
  it("routes only Claude-family providers and refuses credentials in the route env", () => {
    expect(routeFrom({}, "claude")).toMatchObject({ ok: true, route: { providerId: "claude", command: ["claude"], env: {} } });
    expect(routeFrom({ claude: { enabled: false } }, "claude")).toMatchObject({ ok: false, error: "route_disabled" });
    expect(routeFrom({ codex: {} }, "codex")).toMatchObject({ ok: false, error: "route_not_claude" });
    expect(routeFrom({ work: { extends: "claude", env: { ANTHROPIC_API_KEY: "x" } } }, "work")).toMatchObject({ ok: false, error: "route_env_secret" });
    expect(childEnv({ PASEO_AGENT_ID: "a", CLAUDECODE: "1", HOME: "/h" }, { env: { X: "1" } }, "role")).toEqual({ HOME: "/h", X: "1", PASEO_PLUGIN_HELPER_ROLE: "role" });
  });
});

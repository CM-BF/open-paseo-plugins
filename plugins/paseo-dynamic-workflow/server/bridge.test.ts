import { execFile } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { BindingStore } from "./bindings";
import { Bridge } from "./bridge";
import { renderCli } from "./scripts";
import type { WorkflowService } from "./service";

const execFileAsync = promisify(execFile);
const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dwf-bridge-"));
  disposals.push(() => rm(dir, { recursive: true, force: true }));
  const status = vi.fn(async () => "status-ok");
  const launch = vi.fn(async () => "launch-ok");
  const bridge = new Bridge({ service: { status, launch } as unknown as WorkflowService, bindings: new BindingStore(join(dir, "bindings.json")) });
  const socketPath = join(dir, "bridge.sock");
  await bridge.start(socketPath);
  disposals.push(() => bridge.close());
  const cli = join(dir, "cli.mjs");
  await writeFile(cli, renderCli());
  return { socketPath, status, launch, bridge, run: (args: string[]) => execFileAsync(process.execPath, [cli, ...args], {
    env: { ...process.env, DYNAMIC_WORKFLOW_HOME: dir, PASEO_AGENT_ID: "fixture-parent" }, timeout: 5000,
  }) };
}

function post(socketPath: string, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/v1/tools/workflow", method: "POST", headers: { "content-length": Buffer.byteLength(payload) } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

it("returns a useful 413 for oversized bridge bodies and remains reachable", async () => {
  const f = await fixture();
  const response = await post(f.socketPath, JSON.stringify({ arguments: { script: "x".repeat(2 * 1024 * 1024) } }));
  expect(response.status).toBe(413);
  expect(JSON.parse(response.body).error.code).toBe("too_large");
  expect(f.launch).not.toHaveBeenCalled();
  expect((await f.run(["status"])).stdout).toContain("status-ok");
});

it("parses status flags in either order and rejects unknown or misplaced arguments", async () => {
  const f = await fixture();
  await f.run(["status", "--wait", "1", "wf_abcdef"]);
  expect(f.status).toHaveBeenCalledWith("fixture-parent", "wf_abcdef", 1);
  for (const args of [["run", "--name", "test", "--typo", "1"], ["status", "extra", "extra"], ["status", "--wait", "NaN"], ["stop", "--help"]]) {
    await expect(f.run(args)).rejects.toMatchObject({ code: 2 });
  }
});

it("fails startup when its socket cannot listen", async () => {
  const f = await fixture();
  const broken = new Bridge({ service: {} as WorkflowService, bindings: new BindingStore("unused") });
  await expect(broken.start(join(f.socketPath, "missing", "bridge.sock"))).rejects.toThrow();
  expect(broken.listening).toBe(false);
});

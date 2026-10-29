import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
const mock = vi.hoisted(() => ({
  status: { home: "", listen: "127.0.0.1:6767", serverId: "own-host" },
  serverId: "own-host",
  connect: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
  factory: vi.fn(),
  cli: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: null, value: { stdout: string; stderr: string }) => void,
  ) => {
    mock.cli(args);
    callback(null, { stdout: JSON.stringify(mock.status), stderr: "" });
  },
}));
vi.mock("@getpaseo/client", () => ({
  createPaseoApi: () => ({ dispose: mock.dispose }),
}));
vi.mock("@getpaseo/client/node", () => ({
  createHostClient: (...args: unknown[]) => {
    mock.factory(...args);
    return {
      connect: mock.connect,
      close: mock.close,
      getLastServerInfoMessage: () => ({ serverId: mock.serverId }),
    };
  },
}));
import { LocalPaseo, localEndpoint } from "../server/local-paseo";
let home: string;
beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), "upstream-local-client-"));
  mock.status = { home, listen: "127.0.0.1:6767", serverId: "own-host" };
  mock.serverId = "own-host";
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
it("uses the selected home, revalidates reconnect identity and disposes its own client", async () => {
  const local = new LocalPaseo(home);
  const first = await local.get();
  expect(await local.get()).toBe(first);
  expect(mock.factory).toHaveBeenCalledTimes(1);
  expect(mock.cli).toHaveBeenCalledWith([
    "daemon",
    "status",
    "--home",
    home,
    "--json",
  ]);
  expect(mock.connect.mock.calls.length).toBeGreaterThan(1);
  await local.dispose();
  expect(mock.close).toHaveBeenCalled();
  expect(mock.dispose).toHaveBeenCalled();
  await expect(local.get()).rejects.toThrow("已停止");
});
it("refuses a different home before opening a connection", async () => {
  mock.status.home = tmpdir();
  const local = new LocalPaseo(home);
  await expect(local.get()).rejects.toThrow();
  expect(mock.factory).not.toHaveBeenCalled();
  await local.dispose();
});
it("closes on server identity mismatch and can discover a fresh matching connection", async () => {
  const local = new LocalPaseo(home);
  await local.get();
  mock.serverId = "different-host";
  await expect(local.get()).rejects.toThrow("identity");
  expect(mock.close).toHaveBeenCalled();
  mock.serverId = "own-host";
  await local.get();
  expect(mock.factory).toHaveBeenCalledTimes(2);
  await local.dispose();
});
it("restricts resolved endpoints to local sockets or local interfaces", () => {
  expect(localEndpoint("0.0.0.0:6767")).toBe("127.0.0.1:6767");
  expect(localEndpoint("[::]:6767")).toBe("[::1]:6767");
  expect(localEndpoint("/tmp/own-daemon.sock")).toBe("/tmp/own-daemon.sock");
  for (const endpoint of [
    "https://remote.test",
    "remote.test:6767",
    "ssh:remote",
    "127.0.0.1:99999",
  ])
    expect(() => localEndpoint(endpoint)).toThrow();
});

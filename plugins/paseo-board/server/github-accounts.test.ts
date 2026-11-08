import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhCliTransport } from "./github-pages";

type ExecCall = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: string }, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;
const execFile = vi.hoisted(() => vi.fn<ExecCall>());
vi.mock("node:child_process", () => ({ execFile }));

const auth = (login: string, overrides: Record<string, unknown> = {}) => ({ login, host: "github.com", state: "success", active: false, ...overrides });
function reply(stdout: string, stderr = "", error: Error | null = null) {
  execFile.mockImplementationOnce((_file, _args, _options, callback) => callback(error, stdout, stderr));
}
function json(hosts: Record<string, unknown>) { reply(JSON.stringify({ hosts })); }
const exitError = (message: string) => Object.assign(new Error(message), { code: 1 });
const publicStatus = ["auth", "status", "--hostname", "github.com", "--json", "hosts"];
const legacyStatus = ["auth", "status", "--hostname", "github.com"];

describe("GitHub CLI account discovery boundary", () => {
  beforeEach(() => { execFile.mockReset(); execFile.mockImplementation(() => { throw new Error("Unexpected gh command"); }); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("reports enterprise-only login instead of silently returning an empty list on gh JSON exit zero", async () => {
    json({});
    json({ "github.enterprise.example": [auth("employee_name", { host: "github.enterprise.example", token: "PRIVATE_TOKEN", tokenSource: "/private/config" })] });
    const error = await new GhCliTransport().accounts().catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("github.enterprise.example");
    expect((error as Error).message).toContain("gh auth login --hostname github.com");
    expect((error as Error).message).toContain("运行此 Board 的主机");
    expect((error as Error).message).not.toMatch(/PRIVATE_TOKEN|private\/config|employee/);
    expect(execFile.mock.calls.map(call => call.slice(0, 2))).toEqual([["gh", publicStatus], ["gh", ["auth", "status", "--json", "hosts"]]]);
    expect(execFile.mock.calls[1][2].timeout).toBe(3_000);
  });

  it("keeps exit-zero empty-login authentication errors out of account results and diagnostics", async () => {
    json({ "github.com": [auth("", { state: "error", error: "HTTP 401 PRIVATE_TOKEN", token: "PRIVATE_TOKEN" })] });
    json({});
    await expect(new GhCliTransport().accounts()).rejects.toThrow("未找到可用的 github.com 登录账号");
    // No textual retry can swallow the deliberate no-account error or reinterpret failed authentication.
    expect(execFile.mock.calls.map(call => call[1])).toEqual([publicStatus, ["auth", "status", "--json", "hosts"]]);
  });

  it.each([{}, { "github.com": [] }])("rejects an authoritative empty host/account result: %j", async hosts => {
    json(hosts);
    json({});
    await expect(new GhCliTransport().accounts()).rejects.toThrow("gh auth login --hostname github.com");
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("requires verified successful accounts, excluding timeout, unknown state, wrong host and malformed identities", async () => {
    json({ "github.com": [null, "bad", auth("expired", { state: "error" }), auth("slow", { state: "timeout" }), auth("unknown", { state: "unexpected" }), auth("unverified", { state: undefined }), auth("inconsistent", { error: "PRIVATE_ERROR" }), auth("wrong-host", { host: "github.enterprise.example" }), auth("bad login"), auth("", { active: true })] });
    json({});
    await expect(new GhCliTransport().accounts()).rejects.toThrow("未找到可用的 github.com 登录账号");
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("returns only github.com identities while preserving each selected account's active status", async () => {
    json({ "github.com": [auth("writer", { token: "PRIVATE_TOKEN", error: "", tokenSource: "/private/config" }), auth("second", { active: true }), auth("expired", { state: "error" })], "github.enterprise.example": [auth("employee", { host: "github.enterprise.example", active: true })] });
    expect(await new GhCliTransport().accounts()).toEqual([{ login: "writer", host: "github.com", active: false }, { login: "second", host: "github.com", active: true }]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("returns a healthy public account without querying an unrelated slow enterprise host", async () => {
    json({ "github.com": [auth("writer", { active: true })] });
    // If discovery queried all hosts, this simulated timeout would delay or mask the valid account.
    reply("", "PRIVATE_TIMEOUT", Object.assign(new Error("Timed out"), { code: null, killed: true, signal: "SIGTERM" }));
    expect(await new GhCliTransport().accounts()).toEqual([{ login: "writer", host: "github.com", active: true }]);
    expect(execFile.mock.calls.map(call => call[1])).toEqual([publicStatus]);
  });

  it("preserves the actionable no-account error when optional other-host diagnostics time out", async () => {
    json({});
    // A partial success record from a killed process must not be parsed as reliable diagnostics.
    reply(JSON.stringify({ hosts: { "partial.example": [auth("employee", { host: "partial.example" })] } }), "PRIVATE_TIMEOUT", Object.assign(new Error("Timed out"), { code: null, killed: true, signal: "SIGTERM" }));
    const error = await new GhCliTransport().accounts().catch(error => error as Error);
    expect((error as Error).message).toContain("gh auth login --hostname github.com");
    expect((error as Error).message).not.toMatch(/PRIVATE_TIMEOUT|partial\.example/);
    expect(execFile.mock.calls.map(call => call[2].timeout)).toEqual([15_000, 3_000]);
  });

  it("does not retry a failed optional modern diagnostic as another legacy network request", async () => {
    json({}); reply("not JSON", "PRIVATE_DIAGNOSTIC");
    await expect(new GhCliTransport().accounts()).rejects.toThrow("未找到可用的 github.com 登录账号");
    expect(execFile.mock.calls.map(call => call[1])).toEqual([publicStatus, ["auth", "status", "--json", "hosts"]]);
  });

  it.each([
    { code: null, killed: true, signal: "SIGTERM" },
    { code: "ENOENT" },
  ])("does not reinterpret an execution failure as legacy auth output: %j", async details => {
    reply("", "PRIVATE_DIAGNOSTIC", Object.assign(new Error("PRIVATE_ERROR"), details));
    const error = await new GhCliTransport().accounts().catch(error => error as Error);
    expect((error as Error).message).toContain("GitHub CLI authentication is unavailable");
    expect((error as Error).message).not.toMatch(/PRIVATE_DIAGNOSTIC|PRIVATE_ERROR/);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("strips inherited host/token overrides without mutating the daemon environment", async () => {
    const sensitive = ["GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
    for (const key of sensitive) vi.stubEnv(key, "inherited-fixture");
    vi.stubEnv("GH_CONFIG_DIR", "/private/fixture-config");
    json({ "github.com": [auth("writer")] });
    await new GhCliTransport().accounts();
    const options = execFile.mock.calls[0][2];
    expect(options).toMatchObject({ timeout: 15_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", env: { GH_PROMPT_DISABLED: "1", GH_CONFIG_DIR: "/private/fixture-config" } });
    for (const key of sensitive) { expect(options.env).not.toHaveProperty(key); expect(process.env[key]).toBe("inherited-fixture"); }
  });

  it("falls back for older gh JSON flags and reads successful identities from stderr even with an auth failure exit", async () => {
    reply("", "unknown flag --json PRIVATE_DIAGNOSTIC", exitError("CLI argument error"));
    reply("", "github.com\n  ✓ Logged in to github.com account writer (keyring)\n  - Active account: false\n  X Failed to log in to github.com account expired (keyring)\n  - Active account: true\n  - Token: PRIVATE_TOKEN\ngithub.enterprise.example\n  ✓ Logged in to github.enterprise.example account employee (keyring)\n  - Active account: true\n", exitError("Authentication issues"));
    expect(await new GhCliTransport().accounts()).toEqual([{ login: "writer", host: "github.com", active: false }]);
    expect(execFile.mock.calls.map(call => call[1])).toEqual([publicStatus, legacyStatus]);
  });

  it("does not assign a following enterprise account's active flag to a github.com account", async () => {
    reply("not JSON");
    reply("github.com\n  ✓ Logged in to github.com account writer (keyring)\n  - Active account: false\ngithub.enterprise.example\n  ✓ Logged in to github.enterprise.example account employee (keyring)\n  - Active account: true\n");
    expect(await new GhCliTransport().accounts()).toEqual([{ login: "writer", host: "github.com", active: false }]);
  });

  it("preserves legacy as-login output and never returns a raw credential summary", async () => {
    reply("", "unknown flag", exitError("Unsupported flag"));
    reply("", "github.com\n  ✓ Logged in to github.com as legacy (keyring)\n  - Token: PRIVATE_TOKEN\n");
    expect(await new GhCliTransport().accounts()).toEqual([{ login: "legacy", host: "github.com", active: true }]);
  });

  it.each(["null", "{}", '{"hosts":[]}', '{"hosts":null}'])("falls back on unsupported JSON status shape %s", async output => {
    reply(output);
    reply("✓ Logged in to github.com as legacy (keyring)\n");
    expect(await new GhCliTransport().accounts()).toEqual([{ login: "legacy", host: "github.com", active: true }]);
  });

  it("projects only valid successful hostnames into legacy and JSON no-account errors", async () => {
    reply("broken JSON");
    reply("", "You are not logged into any accounts on github.com", exitError("Authentication issues"));
    reply("", "github.enterprise.example\n ✓ Logged in to github.enterprise.example account employee_name (keyring)\n - Token: PRIVATE_TOKEN\n X Failed to log in to expired.example account old (keyring)\n error /private/secret\n", exitError("Authentication issues"));
    const legacyError = await new GhCliTransport().accounts().catch(error => error as Error);
    expect((legacyError as Error).message).toContain("github.enterprise.example");
    expect((legacyError as Error).message).not.toMatch(/expired\.example|PRIVATE_TOKEN|private\/secret/);
    expect(execFile.mock.calls.map(call => call[1])).toEqual([publicStatus, legacyStatus, ["auth", "status"]]);
    expect(execFile.mock.calls[2][2].timeout).toBe(3_000);
    json({});
    json({ "github.enterprise.example": [auth("employee", { host: "github.enterprise.example" })], "unsafe/PRIVATE_TOKEN": [auth("employee")], "expired.example": [auth("old", { host: "expired.example", state: "error" })] });
    const jsonError = await new GhCliTransport().accounts().catch(error => error as Error);
    expect((jsonError as Error).message).toContain("github.enterprise.example");
    expect((jsonError as Error).message).not.toMatch(/expired\.example|PRIVATE_TOKEN/);
  });

  it("keeps credential retrieval pinned to the exact github.com user and never switches gh accounts", async () => {
    vi.stubEnv("GH_HOST", "github.enterprise.example"); vi.stubEnv("GH_TOKEN", "INHERITED_TOKEN");
    reply("SELECTED_ACCOUNT_TOKEN\n");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ login: "writer" }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await new GhCliTransport().request("writer", "GET", "/user")).toEqual({ login: "writer" });
    expect(execFile.mock.calls.map(call => call[1])).toEqual([["auth", "token", "--hostname", "github.com", "--user", "writer"]]);
    expect(execFile.mock.calls[0][2].env).not.toHaveProperty("GH_HOST");
    expect(execFile.mock.calls[0][2].env).not.toHaveProperty("GH_TOKEN");
    expect(fetch).toHaveBeenCalledWith("https://api.github.com/user", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer SELECTED_ACCOUNT_TOKEN" }) }));
  });
});

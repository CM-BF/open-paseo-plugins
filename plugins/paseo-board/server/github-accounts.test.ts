import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhCliTransport, githubApiBase } from "./github-pages";

type ExecCall = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: string }, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;
const execFile = vi.hoisted(() => vi.fn<ExecCall>());
vi.mock("node:child_process", () => ({ execFile }));
const auth = (login: string, overrides: Record<string, unknown> = {}) => ({ login, host: "github.com", state: "success", active: false, ...overrides });
function reply(stdout: string, stderr = "", error: Error | null = null) { execFile.mockImplementationOnce((_file, _args, _options, callback) => callback(error, stdout, stderr)); }
function json(hosts: Record<string, unknown>) { reply(JSON.stringify({ hosts })); }
const exitError = (message: string) => Object.assign(new Error(message), { code: 1 });
const allStatus = ["auth", "status", "--json", "hosts"];
const enterprise = "github.enterprise.example";

describe("host-scoped GitHub CLI account discovery", () => {
  beforeEach(() => { execFile.mockReset(); execFile.mockImplementation(() => { throw new Error("Unexpected gh command"); }); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("returns an Enterprise-only account without requiring public authentication", async () => {
    json({ [enterprise]: [auth("employee_name", { host: enterprise, active: true, token: "PRIVATE_TOKEN", tokenSource: "/private/config" })] });
    expect(await new GhCliTransport().accounts()).toEqual([{ login: "employee_name", host: enterprise, active: true }]);
    expect(execFile.mock.calls.map(call => call[1])).toEqual([allStatus]);
  });
  it("keeps equal logins on different hosts as distinct selected identities", async () => {
    json({ "github.com": [auth("writer", { active: false })], [enterprise]: [auth("writer", { host: enterprise, active: true })] });
    expect(await new GhCliTransport().accounts()).toEqual([{ login: "writer", host: "github.com", active: false }, { login: "writer", host: enterprise, active: true }]);
  });
  it("queries a selected Enterprise host directly and rejects out-of-scope CLI results", async () => {
    json({ "github.com": [auth("wrong")], [enterprise]: [auth("worker", { host: enterprise })] });
    expect(await new GhCliTransport().accounts(enterprise.toUpperCase())).toEqual([{ login: "worker", host: enterprise, active: false }]);
    expect(execFile.mock.calls[0][1]).toEqual(["auth", "status", "--hostname", enterprise, "--json", "hosts"]);
  });
  it("keeps exit-zero empty-login errors out of results without leaking credential diagnostics", async () => {
    json({ [enterprise]: [auth("", { host: enterprise, state: "error", error: "HTTP 401 PRIVATE_TOKEN", token: "PRIVATE_TOKEN" })] });
    const error = await new GhCliTransport().accounts(enterprise).catch(error => error as Error);
    expect((error as Error).message).toContain(`gh auth login --hostname ${enterprise}`);
    expect((error as Error).message).not.toMatch(/PRIVATE_TOKEN|HTTP 401/);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { "github.com": [] }])("rejects empty authoritative account results without format retry: %j", async hosts => {
    json(hosts); await expect(new GhCliTransport().accounts()).rejects.toThrow("未找到可用的 GitHub 登录账号");
    expect(execFile).toHaveBeenCalledTimes(1);
  });
  it("requires verified successful identities and rejects timeout, inconsistent host or unsafe login", async () => {
    json({ "github.com": [null, "bad", auth("expired", { state: "error" }), auth("slow", { state: "timeout" }), auth("unknown", { state: "unexpected" }), auth("unverified", { state: undefined }), auth("inconsistent", { error: "PRIVATE_ERROR" }), auth("wrong", { host: enterprise }), auth("bad login"), auth(""), auth("../escape")], "unsafe/PRIVATE": [auth("hidden")] });
    await expect(new GhCliTransport().accounts()).rejects.toThrow("未找到可用"); expect(execFile).toHaveBeenCalledTimes(1);
  });
  it.each([{ code: null, killed: true, signal: "SIGTERM" }, { code: "ENOENT" }])("does not parse partial output or retry execution failures: %j", async details => {
    reply(JSON.stringify({hosts:{"github.com":[auth("partial")]}}), "PRIVATE_DIAGNOSTIC", Object.assign(new Error("PRIVATE_ERROR"), details));
    const error = await new GhCliTransport().accounts().catch(error => error as Error);
    expect((error as Error).message).toContain("GitHub CLI authentication is unavailable");
    expect((error as Error).message).not.toMatch(/PRIVATE|partial/); expect(execFile).toHaveBeenCalledTimes(1);
  });
  it("strips inherited host/token overrides but preserves host configuration and daemon environment", async () => {
    const keys = ["GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
    for (const key of keys) vi.stubEnv(key, "inherited-fixture"); vi.stubEnv("GH_CONFIG_DIR", "/private/fixture-config");
    json({ [enterprise]: [auth("worker", { host: enterprise })] }); await new GhCliTransport().accounts();
    expect(execFile.mock.calls[0][2]).toMatchObject({ timeout: 15_000, maxBuffer: 2 * 1024 * 1024, env: { GH_PROMPT_DISABLED: "1", GH_CONFIG_DIR: "/private/fixture-config" } });
    for (const key of keys) { expect(execFile.mock.calls[0][2].env).not.toHaveProperty(key); expect(process.env[key]).toBe("inherited-fixture"); }
  });
  it("supports older stderr output while keeping active flags separate across hosts and failed accounts", async () => {
    reply("", "unknown flag --json PRIVATE_DIAGNOSTIC", exitError("CLI argument error"));
    reply("", `github.com\n ✓ Logged in to github.com account writer (keyring)\n - Active account: false\n X Failed to log in to github.com account expired\n - Active account: true\n${enterprise}\n ✓ Logged in to ${enterprise} account employee_name (keyring)\n - Active account: true\n - Token: PRIVATE_TOKEN\n`, exitError("Auth issues"));
    expect(await new GhCliTransport().accounts()).toEqual([{ login: "writer", host: "github.com", active: false }, { login: "employee_name", host: enterprise, active: true }]);
    expect(execFile.mock.calls.map(call => call[1])).toEqual([allStatus, ["auth", "status"]]);
  });
  it.each(["null", "{}", '{"hosts":[]}', '{"hosts":null}'])("falls back on unsupported legacy status shape %s", async output => {
    reply(output); reply(`✓ Logged in to ${enterprise} as employee_name (keyring)\n`);
    expect(await new GhCliTransport().accounts(enterprise)).toEqual([{ login: "employee_name", host: enterprise, active: true }]);
    expect(execFile.mock.calls[1][1]).toEqual(["auth", "status", "--hostname", enterprise]);
  });
  it.each(["https://bad.example", "bad.example/path", "bad.example:8443", "--hostname", "bad host"])("refuses an invalid host before invoking gh: %s", async host => {
    await expect(new GhCliTransport().accounts(host)).rejects.toThrow(); expect(execFile).not.toHaveBeenCalled();
  });
  it.each([
    ["github.com", "https://api.github.com/user"],
    [enterprise, `https://${enterprise}/api/v3/user`],
    ["acme.ghe.com", "https://api.acme.ghe.com/user"],
  ])("pins credentials and API routing to %s without a global account switch", async (host, url) => {
    vi.stubEnv("GH_HOST", "unrelated.example"); vi.stubEnv("GH_TOKEN", "INHERITED_TOKEN"); reply("SELECTED_ACCOUNT_TOKEN\n");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ login: "writer_team" }))); vi.stubGlobal("fetch", fetch);
    expect(await new GhCliTransport().request("writer_team", "GET", "/user", undefined, host)).toEqual({login:"writer_team"});
    expect(execFile.mock.calls.map(call => call[1])).toEqual([["auth", "token", "--hostname", host, "--user", "writer_team"]]);
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer SELECTED_ACCOUNT_TOKEN" }) }));
    expect(execFile.mock.calls[0][2].env).not.toHaveProperty("GH_HOST"); expect(execFile.mock.calls[0][2].env).not.toHaveProperty("GH_TOKEN");
  });
  it("preserves the historical github.com default without making Enterprise calls public", () => {
    expect(githubApiBase()).toBe("https://api.github.com"); expect(githubApiBase(enterprise)).toBe(`https://${enterprise}/api/v3`);
  });
  it.each(["//evil.example/user", "/../../user", "/%2e%2e/user", "/user#token", "/\\evil.example/user"])("rejects escaping an Enterprise API prefix before credential lookup: %s", async path => {
    await expect(new GhCliTransport().request("writer", "GET", path, undefined, enterprise)).rejects.toThrow(); expect(execFile).not.toHaveBeenCalled();
  });
  it("fetches a Pages file without credentials and refuses login redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("artifact")); vi.stubGlobal("fetch", fetch);
    expect(await new GhCliTransport().publicFile(`https://pages.${enterprise}/team/site/index.html?paseo_release=abc`)).toBe("artifact");
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({redirect:"error",headers:{"Cache-Control":"no-cache"}}));
    expect(execFile).not.toHaveBeenCalled();
  });
  it.each(["http://pages.internal.example/", "https://127.0.0.1/", "https://localhost/", "https://user:password@pages.example/", "https://pages.example/#fragment"])("refuses unsafe Pages locations: %s", async url => {
    const fetch = vi.fn(); vi.stubGlobal("fetch",fetch); await expect(new GhCliTransport().publicFile(url)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});

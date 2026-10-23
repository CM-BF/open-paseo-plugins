import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BINDING_ENV, CHILD_ENV, ENABLE_ENV, MCP_SERVER } from "../shared/ids";
import { DEFAULT_PREFERENCES } from "../shared/settings";
import { transformCreate, transformSessionOpen, type CreateRequest } from "./agent-setup";
import { BindingStore } from "./bindings";
import { PROMPT_MARKER } from "./prompts";

const paths = { mcp: "/state/bin/paseo-workflow-mcp", cli: "/state/bin/paseo-workflow" };
const request = (provider: string, env?: Record<string, string>): CreateRequest =>
  ({ config: { provider, cwd: "/repo" }, ...(env ? { env } : {}) }) as unknown as CreateRequest;

describe("transformCreate", () => {
  it("gives MCP providers a bound dormant endpoint without adding a workflow prompt", () => {
    const out = transformCreate(request("claude"), "claude", DEFAULT_PREFERENCES, paths, () => "nonce");
    expect(out?.config.mcpServers?.[MCP_SERVER]).toEqual({ type: "stdio", command: paths.mcp, env: { [BINDING_ENV]: "nonce" } });
    expect(out?.env?.[BINDING_ENV]).toBe("nonce");
    expect(out?.config.toolPolicy?.preapproved.map((grant) => grant.tool)).toContain("workflow");
    expect(out?.config.systemPrompt).toBeUndefined();
  });

  it("gives prompt-only providers instructions only after explicit creation opt-in", () => {
    expect(transformCreate(request("pi"), "pi", DEFAULT_PREFERENCES, paths)).toBeUndefined();
    const out = transformCreate(request("pi", { [ENABLE_ENV]: "1" }), "pi", DEFAULT_PREFERENCES, paths);
    expect(out?.config.mcpServers).toBeUndefined();
    expect(out?.config.systemPrompt).toContain(paths.cli);
  });

  it("uses CLI for OpenCode to preserve its shared server", () => {
    const out = transformCreate(request("opencode"), "opencode", DEFAULT_PREFERENCES, paths);
    expect(out?.config.mcpServers).toBeUndefined();
    expect(out?.env).toBeUndefined();
    expect(out?.config.systemPrompt).toBeUndefined();
  });

  it("leaves workflow children and unknown providers alone", () => {
    expect(transformCreate(request("claude", { [CHILD_ENV]: "wf_1" }), "claude", DEFAULT_PREFERENCES, paths)).toBeUndefined();
    expect(transformCreate(request("acme"), null, DEFAULT_PREFERENCES, paths)).toBeUndefined();
  });

  it("does not leak an enabled parent's prompt, binding or grants into a workflow child", () => {
    const parent = transformCreate(request("claude"), "claude", DEFAULT_PREFERENCES, paths, () => "old")!;
    const child = transformCreate({
      ...parent,
      config: { ...parent.config, systemPrompt: `Keep this.\n\n${PROMPT_MARKER}\nOld workflow instructions.\n## Another plugin\nKeep this too.` },
      env: { ...parent.env, [CHILD_ENV]: "wf_child", [ENABLE_ENV]: "1" },
    }, "claude", DEFAULT_PREFERENCES, paths);
    expect(child?.config.mcpServers).toBeUndefined();
    expect(child?.config.toolPolicy).toBeUndefined();
    expect(child?.env?.[BINDING_ENV]).toBeUndefined();
    expect(child?.env?.[ENABLE_ENV]).toBeUndefined();
    expect(child?.config.systemPrompt).toContain("Keep this.");
    expect(child?.config.systemPrompt).toContain("Another plugin");
    expect(child?.config.systemPrompt).not.toContain(PROMPT_MARKER);
  });

  it("rebinds copied configs without inheriting old workflow instructions or modifying unrelated tools", () => {
    const parent = transformCreate(request("claude"), "claude", DEFAULT_PREFERENCES, paths, () => "old")!;
    parent.config.systemPrompt = `${PROMPT_MARKER}\nOld instructions.`;
    parent.config.mcpServers!.other = { type: "stdio", command: "/other" };
    const copy = transformCreate(parent, "codex", DEFAULT_PREFERENCES, paths, () => "new")!;
    expect(copy.env?.[BINDING_ENV]).toBe("new");
    expect(copy.config.mcpServers?.other).toEqual({ type: "stdio", command: "/other" });
    expect(copy.config.systemPrompt).toBeUndefined();
    expect(parent.env?.[BINDING_ENV]).toBe("old");
  });
});

describe("transformSessionOpen", () => {
  it("binds the nonce on create and strips both markers from the env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dwf-bind-"));
    try {
      const bindings = new BindingStore(join(dir, "bindings.json"));
      const out = await transformSessionOpen(
        {
          agentId: "agent-1",
          workspaceId: null,
          provider: "claude",
          cwd: "/repo",
          reason: "create",
          purpose: "interactive",
          env: { [BINDING_ENV]: "n1", [CHILD_ENV]: "wf_1", [ENABLE_ENV]: "1", KEEP: "1" },
        },
        bindings,
      );
      expect(out?.env).toEqual({ KEEP: "1" });
      expect(bindings.get("n1")?.agentId).toBe("agent-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

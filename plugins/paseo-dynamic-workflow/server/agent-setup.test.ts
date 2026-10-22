import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BINDING_ENV, CHILD_ENV, MCP_SERVER } from "../shared/ids";
import { DEFAULT_PREFERENCES } from "../shared/settings";
import { transformCreate, transformSessionOpen, type CreateRequest } from "./agent-setup";
import { BindingStore } from "./bindings";
import { PROMPT_MARKER } from "./prompts";

const paths = { mcp: "/state/bin/paseo-workflow-mcp", cli: "/state/bin/paseo-workflow" };
const request = (provider: string, env?: Record<string, string>): CreateRequest =>
  ({ config: { provider, cwd: "/repo" }, ...(env ? { env } : {}) }) as unknown as CreateRequest;

describe("transformCreate", () => {
  it("gives MCP providers the server, a binding, preapproval and the prompt", () => {
    const out = transformCreate(request("claude"), "claude", DEFAULT_PREFERENCES, paths, () => "nonce");
    expect(out?.config.mcpServers?.[MCP_SERVER]).toEqual({ type: "stdio", command: paths.mcp, env: { [BINDING_ENV]: "nonce" } });
    expect(out?.env?.[BINDING_ENV]).toBe("nonce");
    expect(out?.config.toolPolicy?.preapproved.map((grant) => grant.tool)).toContain("workflow");
    expect(out?.config.systemPrompt).toContain(PROMPT_MARKER);
  });

  it("gives prompt-only providers the CLI instructions and no server", () => {
    const out = transformCreate(request("pi"), "pi", DEFAULT_PREFERENCES, paths);
    expect(out?.config.mcpServers).toBeUndefined();
    expect(out?.config.systemPrompt).toContain(paths.cli);
  });

  it("leaves workflow children and unknown providers alone", () => {
    expect(transformCreate(request("claude", { [CHILD_ENV]: "wf_1" }), "claude", DEFAULT_PREFERENCES, paths)).toBeUndefined();
    expect(transformCreate(request("acme"), null, DEFAULT_PREFERENCES, paths)).toBeUndefined();
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
          env: { [BINDING_ENV]: "n1", [CHILD_ENV]: "wf_1", KEEP: "1" },
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

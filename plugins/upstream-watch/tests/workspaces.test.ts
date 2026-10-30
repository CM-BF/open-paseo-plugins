import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { describe, expect, it, vi } from "vitest";
import { environment } from "../server/workspaces";

type PaseoApi = PluginHandlerContext["paseo"];

function fixture() {
  const list = vi.fn().mockResolvedValue({
    entries: [],
    pageInfo: { hasMore: false },
  });
  const projects = vi.fn().mockResolvedValue({ projects: [] });
  const providers = vi.fn().mockResolvedValue({
    providers: [
      { provider: "codex", available: true },
      { provider: "unavailable", available: false },
    ],
  });
  const create = vi.fn();
  const open = vi.fn();
  const api = {
    workspaces: { list, create, open },
    projects: { list: projects },
    providers: { listAvailable: providers },
  } as unknown as PaseoApi;
  return { api, list, projects, providers, create, open };
}

function project(id: string, customName?: string) {
  return {
    projectId: id,
    projectDisplayName: `Project ${id}`,
    projectCustomName: customName,
    projectRootPath: `/projects/${id}`,
  };
}

function workspace(id: string, projectId: string, background = false) {
  return {
    id,
    projectId,
    name: `Workspace ${id}`,
    projectRootPath: `/projects/${projectId}`,
    background,
  };
}

describe("workspace picker environment", () => {
  it("includes empty projects and completes all pages before hiding background-only projects", async () => {
    const { api, list, projects, create, open } = fixture();
    list
      .mockResolvedValueOnce({
        entries: [
          workspace("wks_0000000000000001", "hidden", true),
          workspace("wks_0000000000000002", "mixed", true),
        ],
        pageInfo: { hasMore: true, nextCursor: "page-2" },
      })
      .mockResolvedValueOnce({
        entries: [
          {
            ...workspace("wks_0000000000000003", "mixed"),
            workspaceDirectory: "/checkouts/mixed",
          },
          workspace("wks_0000000000000004", "normal"),
        ],
        pageInfo: { hasMore: false },
      });
    projects.mockResolvedValue({
      projects: [
        project("empty", "  My project  "),
        project("hidden"),
        project("mixed"),
        project("normal", "  "),
      ],
    });

    expect(await environment(api)).toEqual({
      workspaces: [
        {
          id: "wks_0000000000000003",
          name: "Workspace wks_0000000000000003",
          directory: "/checkouts/mixed",
        },
        {
          id: "wks_0000000000000004",
          name: "Workspace wks_0000000000000004",
          directory: "/projects/normal",
        },
      ],
      projects: [
        { id: "empty", name: "My project", directory: "/projects/empty" },
        { id: "mixed", name: "Project mixed", directory: "/projects/mixed" },
        { id: "normal", name: "Project normal", directory: "/projects/normal" },
      ],
      providers: [{ id: "codex", label: "codex" }],
    });
    expect(list.mock.calls.map(([options]) => options)).toEqual([
      { includeBackground: true, page: { limit: 200 } },
      { includeBackground: true, page: { limit: 200, cursor: "page-2" } },
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("omits workspaces being archived while retaining their ordinary project", async () => {
    const { api, list, projects } = fixture();
    list.mockResolvedValue({
      entries: [
        {
          ...workspace("wks_0000000000000001", "mixed"),
          archivingAt: "2026-10-29T10:00:00Z",
        },
        workspace("wks_0000000000000002", "mixed", true),
      ],
      pageInfo: { hasMore: false },
    });
    projects.mockResolvedValue({ projects: [project("mixed")] });

    expect(await environment(api)).toMatchObject({
      workspaces: [],
      projects: [
        { id: "mixed", name: "Project mixed", directory: "/projects/mixed" },
      ],
    });
  });

  it.each([undefined, "repeated"])(
    "rejects incomplete pagination with next cursor %s",
    async (nextCursor) => {
      const { api, list } = fixture();
      list.mockResolvedValue({
        entries: [],
        pageInfo: { hasMore: true, nextCursor },
      });
      await expect(environment(api)).rejects.toThrow("分页未完整返回");
      expect(list).toHaveBeenCalledTimes(nextCursor ? 2 : 1);
    },
  );

  it.each(["workspaces", "projects", "providers"])(
    "does not return a partial environment when %s fails",
    async (source) => {
      const { api, list, projects, providers } = fixture();
      const fail = source === "workspaces" ? list : source === "projects" ? projects : providers;
      fail.mockRejectedValue(new Error(`${source} unavailable`));
      await expect(environment(api)).rejects.toThrow(`${source} unavailable`);
    },
  );

  it("propagates the provider catalog's reported error", async () => {
    const { api, providers } = fixture();
    providers.mockResolvedValue({ providers: [], error: "Provider catalog unavailable" });
    await expect(environment(api)).rejects.toThrow("Provider catalog unavailable");
  });
});

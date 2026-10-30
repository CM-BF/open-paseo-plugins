import type { PaseoWorkspaceCreateOptions, PaseoWorkspaceHandle } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";
import { completeWorkspaceCreation, findWorkspaceCreation, prepareWorkspaceCreation } from "../client/workspace-creation";

const project = { id: "project-one", name: "Fixture", directory: "/tmp/plugin-test-fixture" };
const workspace = { id: "wks_0123456789abcdef", name: "Fixture · 上游更新", directory: project.directory } as PaseoWorkspaceHandle;

describe("project workspace creation", () => {
  it("shares concurrent requests and reuses a completed result until the picker accepts it", async () => {
    let finish!: (value: PaseoWorkspaceHandle) => void;
    const create = vi.fn((_request: PaseoWorkspaceCreateOptions) => new Promise<PaseoWorkspaceHandle>((resolve) => { finish = resolve; }));
    const client = { workspaces: { create } };
    const operation = prepareWorkspaceCreation(client, project);
    const first = operation.run();
    const second = operation.run();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    finish(workspace);
    expect(await first).toEqual(workspace);
    const remountedOperation = prepareWorkspaceCreation(client, project);
    expect(remountedOperation).toBe(operation);
    expect(await remountedOperation.run()).toEqual(workspace);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      title: "Fixture · 上游更新",
      source: { kind: "directory", path: project.directory, projectId: project.id },
      background: false,
      idempotencyKey: expect.any(String),
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("agent");
    completeWorkspaceCreation(client, operation);
    expect(findWorkspaceCreation(client, project.id)).toBeUndefined();
    const next = prepareWorkspaceCreation(client, project);
    expect(next.request.idempotencyKey).not.toBe(operation.request.idempotencyKey);
  });

  it("retains a failed request and its frozen directory when a form remounts", async () => {
    const failure = new Error("response lost");
    const create = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(workspace);
    const client = { workspaces: { create } };
    const input = { ...project };
    const operation = prepareWorkspaceCreation(client, input);
    await expect(operation.run()).rejects.toBe(failure);
    expect(operation.error).toBe(failure);
    input.directory = "/tmp/plugin-test-moved";
    const retry = prepareWorkspaceCreation(client, input);
    expect(retry).toBe(operation);
    expect(retry.project.directory).toBe(project.directory);
    await expect(retry.run()).resolves.toEqual(workspace);
    expect(create.mock.calls[1]?.[0]).toBe(create.mock.calls[0]?.[0]);
    expect(retry.error).toBeNull();
  });

  it("keeps another project and another host separate without losing an unresolved intent", async () => {
    const client = { workspaces: { create: vi.fn().mockRejectedValue(new Error("offline")) } };
    const otherHost = { workspaces: { create: vi.fn().mockResolvedValue(workspace) } };
    const first = prepareWorkspaceCreation(client, project);
    await expect(first.run()).rejects.toThrow("offline");
    const second = prepareWorkspaceCreation(client, { ...project, id: "project-two" });
    const other = prepareWorkspaceCreation(otherHost, project);
    expect(second.request.idempotencyKey).not.toBe(first.request.idempotencyKey);
    expect(other.request.idempotencyKey).not.toBe(first.request.idempotencyKey);
    expect(prepareWorkspaceCreation(client, project)).toBe(first);
    completeWorkspaceCreation(client, other);
    expect(findWorkspaceCreation(client, project.id)).toBe(first);
  });
});

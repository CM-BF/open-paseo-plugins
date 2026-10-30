import type { PaseoWorkspaceCreateOptions, PaseoWorkspaceHandle } from "@getpaseo/client";

export interface WorkspaceChoice {
  id: string;
  name: string;
  directory: string;
}

interface WorkspaceClient {
  workspaces: {
    create(request: PaseoWorkspaceCreateOptions): Promise<PaseoWorkspaceHandle>;
  };
}

export interface WorkspaceCreation {
  readonly project: WorkspaceChoice;
  readonly request: PaseoWorkspaceCreateOptions;
  error: unknown;
  run(): Promise<WorkspaceChoice>;
}

// Keep unresolved requests across form collapse/remount. The same project on
// another host has a separate request, owned by that host's SDK instance.
const creations = new WeakMap<WorkspaceClient, Map<string, WorkspaceCreation>>();

export function findWorkspaceCreation(client: WorkspaceClient, projectId: string) {
  return creations.get(client)?.get(projectId);
}

export function prepareWorkspaceCreation(client: WorkspaceClient, project: WorkspaceChoice): WorkspaceCreation {
  const previous = findWorkspaceCreation(client, project.id);
  if (previous) return previous;
  const frozenProject = { ...project };
  const request: PaseoWorkspaceCreateOptions = {
    title: `${frozenProject.name} · 上游更新`,
    source: { kind: "directory", path: frozenProject.directory, projectId: frozenProject.id },
    background: false,
    idempotencyKey: `upstream-watch:workspace:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
  };
  let pending: Promise<WorkspaceChoice> | undefined;
  let result: WorkspaceChoice | undefined;
  const operation: WorkspaceCreation = {
    project: frozenProject,
    request,
    error: null,
    run() {
      if (result) return Promise.resolve(result);
      if (pending) return pending;
      operation.error = null;
      pending = Promise.resolve().then(() => client.workspaces.create(request)).then((workspace) => {
        result = {
          id: workspace.id,
          name: workspace.name || request.title || frozenProject.name,
          directory: workspace.directory || frozenProject.directory,
        };
        return result;
      }).catch((error: unknown) => {
        operation.error = error;
        throw error;
      }).finally(() => { pending = undefined; });
      return pending;
    },
  };
  let hostCreations = creations.get(client);
  if (!hostCreations) {
    hostCreations = new Map();
    creations.set(client, hostCreations);
  }
  hostCreations.set(project.id, operation);
  return operation;
}

export function completeWorkspaceCreation(client: WorkspaceClient, operation: WorkspaceCreation) {
  const hostCreations = creations.get(client);
  if (hostCreations?.get(operation.project.id) === operation) hostCreations.delete(operation.project.id);
}

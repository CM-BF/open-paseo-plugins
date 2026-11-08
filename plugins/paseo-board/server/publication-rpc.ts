import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { Board } from "../shared/contracts";
import {
  createReleaseRpc, listReleasesRpc, previewReleaseRpc, downloadReleaseRpc,
  githubAccountsRpc, githubRepositoriesRpc, preparePagesRpc, publishPagesRpc, mergePagesRpc,
  refreshPagesRpc, listPagesJobsRpc, type PagesJob, type PagesPrepareInput,
  type GitHubAccount, type GitHubRepository,
} from "../shared/release-contracts";
import type { ReleaseRepository } from "./static-release";

export interface PagesGateway {
  accounts(githubHost?: string): Promise<GitHubAccount[]>;
  repositories(account: string, githubHost?: string): Promise<GitHubRepository[]>;
  prepare(input: PagesPrepareInput): Promise<PagesJob>;
  publish(input: PagesPrepareInput): Promise<PagesJob>;
  merge(input: { jobId: string; expectedHead: string }): Promise<PagesJob>;
  refresh(jobId: string): Promise<PagesJob>;
  list(releaseId?: string): Promise<PagesJob[]>;
  read(jobId: string): Promise<PagesJob>;
}

/** Host-user RPCs only: these operations are not exposed by the agent Board bridge. */
export function registerPublicationRpc(server: PluginServerContext, options: {
  ready(): Promise<void>; requireBoard(id: string): Promise<Board>;
  releases: ReleaseRepository; pages: PagesGateway;
}): void {
  const { releases, pages } = options;
  const release = async (id: string) => {
    await options.ready();
    return releases.read(id);
  };
  server.handle(createReleaseRpc, async input => {
    await options.ready();
    const board = await options.requireBoard(input.boardId);
    return (await releases.create({ ...input, board })).manifest;
  });
  server.handle(listReleasesRpc, async input => {
    await options.ready(); await options.requireBoard(input.boardId);
    return (await releases.list(input.boardId)).map(item => item.manifest);
  });
  server.handle(previewReleaseRpc, async input => { await release(input.releaseId); return releases.preview(input.releaseId); });
  server.handle(downloadReleaseRpc, async input => { await release(input.releaseId); return releases.download(input.releaseId); });
  server.handle(githubAccountsRpc, async input => { await options.ready(); return pages.accounts(input.githubHost); });
  server.handle(githubRepositoriesRpc, async input => { await options.ready(); return pages.repositories(input.account, input.githubHost); });
  server.handle(preparePagesRpc, async input => { await release(input.releaseId); return pages.prepare(input); });
  server.handle(publishPagesRpc, async input => { await release(input.releaseId); return pages.publish(input); });
  server.handle(mergePagesRpc, async input => {
    await options.ready(); const job = await pages.read(input.jobId); await release(job.releaseId);
    return pages.merge(input);
  });
  server.handle(refreshPagesRpc, async input => {
    await options.ready(); const job = await pages.read(input.jobId); await release(job.releaseId);
    return pages.refresh(input.jobId);
  });
  server.handle(listPagesJobsRpc, async input => {
    await options.ready(); if (input.releaseId) await release(input.releaseId);
    return pages.list(input.releaseId);
  });
}

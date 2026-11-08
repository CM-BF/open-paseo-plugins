import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BoardSchema } from "../shared/contracts";
import { GitHubPagesManager } from "./github-pages";
import { ReleaseRepository, serveRelease } from "./static-release";

const HELP = `Board static release CLI (run after npm ci)

export --board <board-read.json> --public-data <public.json> --out <new-directory>
       [--zip <new.zip>] [--store <private-release-directory>] [--network offline|cdn]
       [--theme light|dark] [--title <title>] [--serve]
serve  --store <private-release-directory> --release <release-id>
accounts [--github-host <hostname>]
repositories --account <login> [--github-host <hostname>]
prepare --store <private-release-directory> --jobs <private-job-directory>
        --release <id> --hash <artifact-sha256> --account <login> --repo <owner/repo>
        --event <immutable-id> [--github-host <hostname>] [--create-repository public|private]
publish --store <private-release-directory> --jobs <private-job-directory>
        --release <id> --hash <artifact-sha256> --account <login> --repo <owner/repo>
        --event <immutable-id> [--github-host <hostname>] [--create-repository public|private]
merge   --store <directory> --jobs <directory> --job <id> --head <exact-pr-sha>
refresh --store <directory> --jobs <directory> --job <id>
jobs    --store <directory> --jobs <directory> [--release <id>]

export/serve operate locally. prepare uploads the reviewed public artifact and creates a PR.
merge requires successful exact-head validation before merging and enabling Pages.
publish authorizes and automatically completes PR, merge and deployment verification.
No command switches the active gh account. Do not publish private content without review.
Repository and publication commands default to github.com for old requests.
Account discovery lists configured GitHub hosts unless --github-host selects one.
`;

export async function releaseMain(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes("--help")) { process.stdout.write(HELP); return; }
  const [command, ...rest] = argv, flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index]; if (!key.startsWith("--") || Object.hasOwn(flags, key)) throw new Error(`Invalid or duplicate argument ${key}`);
    if (key === "--serve") flags[key] = "true";
    else { const value = rest[++index]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`); flags[key] = value; }
  }
  const publicationFlags = ["--store", "--jobs", "--release", "--hash", "--account", "--repo", "--event", "--github-host", "--create-repository"];
  const allowed: Record<string, string[]> = {
    export: ["--board", "--public-data", "--out", "--zip", "--store", "--network", "--theme", "--title", "--serve"],
    serve: ["--store", "--release"], accounts: ["--github-host"], repositories: ["--account", "--github-host"],
    prepare: publicationFlags, publish: publicationFlags,
    merge: ["--store", "--jobs", "--job", "--head"], refresh: ["--store", "--jobs", "--job"],
    jobs: ["--store", "--jobs", "--release"],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown command ${command}`);
  for (const key of Object.keys(flags)) if (!allowed[command].includes(key)) throw new Error(`Unsupported argument ${key} for ${command}`);
  const required = (key: string) => { const value = flags[key]; if (!value) throw new Error(`Missing ${key}`); return value; };
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  const serve = async (repository: ReleaseRepository, releaseId: string) => {
    const server = await serveRelease(await repository.read(releaseId)); output({ status: "previewing", releaseId, url: server.url });
    await new Promise<void>(resolve => { process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve()); }); await server.close();
  };
  if (command === "export") {
    const raw = JSON.parse(await readFile(required("--board"), "utf8")), board = BoardSchema.parse(raw.board ?? raw);
    const publicData = JSON.parse(await readFile(required("--public-data"), "utf8"));
    const temporary = flags["--store"] ? undefined : await mkdtemp(join(tmpdir(), "board-release-export-"));
    const repository = new ReleaseRepository(flags["--store"] ?? temporary!);
    try {
      const release = await repository.create({ board, boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData, network: flags["--network"] as "offline" | "cdn" | undefined, theme: flags["--theme"] as "light" | "dark" | undefined, title: flags["--title"] });
      await repository.export(release.manifest.releaseId, { directory: required("--out"), zipPath: flags["--zip"] });
      output({ status: "exported", manifest: release.manifest, directory: flags["--out"], zip: flags["--zip"] });
      if (flags["--serve"]) await serve(repository, release.manifest.releaseId);
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    return;
  }
  if (command === "serve") { await serve(new ReleaseRepository(required("--store")), required("--release")); return; }
  // Account discovery does not need or create local stores.
  const manager = new GitHubPagesManager(flags["--jobs"] ?? "", new ReleaseRepository(flags["--store"] ?? ""));
  if (command === "accounts") { output(await manager.accounts(flags["--github-host"])); return; }
  if (command === "repositories") { output(await manager.repositories(required("--account"), flags["--github-host"])); return; }
  required("--jobs"); required("--store");
  if (command === "prepare" || command === "publish") {
    const request = { eventId: required("--event"), releaseId: required("--release"), artifactHash: required("--hash"), githubHost: flags["--github-host"], account: required("--account"), repository: required("--repo"), createRepository: flags["--create-repository"] as "public" | "private" | undefined };
    if (command === "prepare") output(await manager.prepare(request));
    else {
      try {
        let job = await manager.publish(request), previous = "";
        for (;;) {
          const serialized = JSON.stringify(job); if (serialized !== previous) { output(job); previous = serialized; }
          if (job.status === "live") break;
          if (job.status === "failed" || !job.autoPublish) throw new Error(job.error ?? "Publication stopped");
          await delay(5_000); job = await manager.read(job.jobId);
        }
      } finally { await manager.close(); }
    }
  }
  else if (command === "merge") output(await manager.merge({ jobId: required("--job"), expectedHead: required("--head") }));
  else if (command === "refresh") output(await manager.refresh(required("--job")));
  else if (command === "jobs") output(await manager.list(flags["--release"]));
  else throw new Error(`Unknown command ${command}`);
}

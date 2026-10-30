import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSources, resolvePaseoCli } from "../server/discovery";

const execute = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "upstream-discovery-"));
  temporary.push(root);
  return root;
}
async function json(path: string, data: unknown) {
  await writeFile(path, JSON.stringify(data));
}
async function init(path: string) {
  await execute("git", ["init", "--quiet", path]);
}
function dependencies(plugins: unknown[]) {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    run: async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "/test/paseo") return JSON.stringify(plugins);
      return (await execute(command, args, { encoding: "utf8" })).stdout;
    },
  };
}
const commit = "4f130e1b4fa4a718e61bbaaec05f3d8b06ece049";

describe("Paseo CLI resolution", () => {
  const bundled = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
  it("prefers the explicit CLI path over environment and bundled paths", () => {
    expect(
      resolvePaseoCli({
        cliPath: "/explicit/with spaces/paseo",
        env: { PASEO_CLI: "/env/paseo", PASEO_BIN: "/env/bin" },
        platform: "darwin",
        exists: () => true,
      }),
    ).toBe("/explicit/with spaces/paseo");
  });
  it("prefers PASEO_CLI, then PASEO_BIN, without consulting a real filesystem", () => {
    expect(
      resolvePaseoCli({
        env: { PASEO_CLI: "/configured/paseo", PASEO_BIN: "/second/paseo" },
        platform: "darwin",
        exists: () => {
          throw new Error("must not probe fallback");
        },
      }),
    ).toBe("/configured/paseo");
    expect(
      resolvePaseoCli({
        env: { PASEO_CLI: "  ", PASEO_BIN: "/bin/paseo" },
        platform: "darwin",
        exists: () => false,
      }),
    ).toBe("/bin/paseo");
  });
  it("uses an existing macOS Desktop bundle before PATH", () => {
    const probed: string[] = [];
    expect(
      resolvePaseoCli({
        env: {},
        platform: "darwin",
        exists: (path) => {
          probed.push(path);
          return true;
        },
      }),
    ).toBe(bundled);
    expect(probed).toEqual([bundled]);
  });
  it("falls back to PATH without a macOS bundle or on other platforms", () => {
    expect(
      resolvePaseoCli({ env: {}, platform: "darwin", exists: () => false }),
    ).toBe("paseo");
    for (const platform of ["linux", "win32"] as const) {
      expect(
        resolvePaseoCli({
          env: {},
          platform,
          exists: () => {
            throw new Error("must not probe macOS bundle");
          },
        }),
      ).toBe("paseo");
    }
  });
});

describe("bounded explicit upstream discovery", () => {
  it("uses an explicit daemon home and reads the real CrossPet metadata shape", async () => {
    const root = await directory();
    const home = join(root, "home");
    const path = join(root, "crosspet");
    await mkdir(path);
    await init(path);
    await json(join(path, "UPSTREAM.json"), {
      repository: "https://github.com/lokicorvus/crosspet",
      commit,
      version: "1.3.2",
    });
    const deps = dependencies([
      {
        id: "crosspet",
        path,
        installation: { identity: { kind: "directory", path } },
      },
    ]);
    const result = await discoverSources(
      { home, cliPath: "/test/paseo" },
      deps,
    );
    expect(deps.calls[0].args).toEqual([
      "--home",
      home,
      "plugin",
      "ls",
      "--json",
    ]);
    expect(result[0].targetPath).toBe(
      await import("node:fs/promises").then((fs) => fs.realpath(path)),
    );
    expect(result[0].sources[0]).toMatchObject({
      repository: "https://github.com/lokicorvus/crosspet",
      baseline: commit,
      relationship: "fork",
      paths: [],
    });
  });

  it("finds nested OMH SOURCE metadata without pretending its installed snapshot is editable", async () => {
    const root = await directory();
    const home = join(root, "home");
    const path = join(home, "local-plugins", "skills-center", "snapshot");
    const skill = join(path, "catalog", "omh", "skills", "onboarding");
    await mkdir(skill, { recursive: true });
    await init(path);
    await json(join(skill, "SOURCE.json"), {
      version: 1,
      upstream: {
        url: "https://github.com/rlaope/oh-my-hermes",
        commit,
        subpath: "agent-skills/onboarding",
      },
    });
    const result = await discoverSources(
      { home, cliPath: "/test/paseo" },
      dependencies([{ id: "skills-center", path }]),
    );
    expect(result[0].targetPath).toBeUndefined();
    expect(result[0].sources[0]).toMatchObject({
      repository: "https://github.com/rlaope/oh-my-hermes",
      baseline: commit,
      paths: ["agent-skills/onboarding"],
    });
  });

  it("keeps remote-only candidates unbased instead of substituting local HEAD", async () => {
    const root = await directory();
    const path = join(root, "fork");
    await mkdir(path);
    await init(path);
    await execute("git", [
      "-C",
      path,
      "remote",
      "add",
      "upstream",
      "git@github.com:example/original.git",
    ]);
    await execute("git", [
      "-C",
      path,
      "remote",
      "add",
      "origin",
      "https://github.com/me/fork.git",
    ]);
    const result = await discoverSources(
      { home: join(root, "home"), cliPath: "/test/paseo" },
      dependencies([{ id: "fork", path }]),
    );
    expect(result[0].sources).toHaveLength(2);
    expect(
      result[0].sources.every((source) => source.baseline === undefined),
    ).toBe(true);
    expect(
      result[0].sources.find((source) => source.relationship === "fork")
        ?.repository,
    ).toBe("https://github.com/example/original");
    expect(result[0].sources[0].notes).toContain("未使用本地 HEAD 代替");
  });

  it("preserves separate tracked branches sharing one adopted commit and path scope", async () => {
    const root = await directory();
    const path = join(root, "plugin");
    await mkdir(path);
    await json(join(path, "UPSTREAM.json"), {
      sources: [
        { repository: "example/original", commit, ref: "main", paths: ["src"] },
        { repository: "example/original", commit, ref: "next", paths: ["src"] },
      ],
    });
    const result = await discoverSources(
      { home: join(root, "home"), cliPath: "/test/paseo" },
      dependencies([{ id: "plugin", path }]),
    );
    expect(result[0].sources.map((source) => source.ref).sort()).toEqual([
      "main",
      "next",
    ]);
    expect(
      result[0].sources.every(
        (source) => source.baseline === commit && source.paths[0] === "src",
      ),
    ).toBe(true);
  });

  it("takes adopted Git installation revision from the catalog while preserving snapshot ownership", async () => {
    const root = await directory();
    const path = join(root, "managed");
    await mkdir(path);
    await init(path);
    const result = await discoverSources(
      { home: join(root, "home"), cliPath: "/test/paseo" },
      dependencies([
        {
          id: "managed",
          path,
          installation: {
            identity: {
              kind: "git",
              remote: "https://github.com/example/plugin",
              pluginPath: ".",
            },
            currentRevision: commit,
          },
        },
      ]),
    );
    expect(result[0].targetPath).toBeUndefined();
    expect(result[0].sources[0].baseline).toBe(commit);
    expect(result[0].sources[0].notes).toContain("原生 plugin update");
  });

  it("reads development UPSTREAM manifests and chooses that proven checkout instead of installed copies", async () => {
    const root = await directory();
    const home = join(root, "home");
    const installed = join(home, "local-plugins", "learning-loop", "snapshot");
    const dev = join(root, "development");
    const plugin = join(dev, "plugins", "learning-loop");
    await mkdir(installed, { recursive: true });
    await mkdir(plugin, { recursive: true });
    await init(dev);
    await json(join(plugin, "paseo-plugin.json"), {
      id: "learning-loop",
      name: "Learning Loop",
    });
    await json(join(plugin, "UPSTREAM.json"), {
      version: 1,
      sources: [
        {
          name: "Hermes memory",
          repository: "NousResearch/hermes-agent",
          commit,
          paths: ["agent/memory_provider.py"],
          relationship: "feature",
          notes: "仅参考记忆机制",
        },
      ],
    });
    const result = await discoverSources(
      { home, cliPath: "/test/paseo", developmentRoot: dev },
      dependencies([{ id: "learning-loop", path: installed }]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].installedPath).toBe(installed);
    expect(
      result[0].targetPath?.endsWith("/development/plugins/learning-loop"),
    ).toBe(true);
    expect(result[0].sources[0]).toMatchObject({
      baseline: commit,
      relationship: "feature",
      paths: ["agent/memory_provider.py"],
    });
    expect(result[0].sources[0].notes).toContain("仅参考记忆机制");
  });

  it("reports invalid/oversized metadata and ignores symlinked files/directories and README guesses", async () => {
    const root = await directory();
    const path = join(root, "plugin");
    await mkdir(path);
    await writeFile(join(path, "SOURCE.json"), "{bad");
    await writeFile(join(path, "UPSTREAM.json"), " ".repeat(100_000));
    await writeFile(
      join(path, "README.md"),
      "reference https://github.com/example/guessed commit " + commit,
    );
    const outside = join(root, "outside");
    await mkdir(outside);
    await json(join(outside, "SOURCE.json"), {
      repository: "example/escaped",
      commit,
    });
    await symlink(outside, join(path, "catalog"));
    const result = await discoverSources(
      { home: join(root, "home"), cliPath: "/test/paseo" },
      dependencies([{ id: "plugin", path }]),
    );
    expect(result[0].sources).toEqual([]);
    expect(result[0].note).toContain("无法解析");
    expect(result[0].note).toContain("超过大小上限");
    expect(result[0].targetPath).toBeUndefined();
    expect(await readFile(join(outside, "SOURCE.json"), "utf8")).toContain(
      "escaped",
    );
  });

  it("requires absolute daemon and development paths and valid CLI catalog output", async () => {
    await expect(
      discoverSources({ home: "relative" }, dependencies([])),
    ).rejects.toThrow("绝对路径");
    const root = await directory();
    await expect(
      discoverSources(
        { home: root, cliPath: "/test/paseo", developmentRoot: "relative" },
        dependencies([]),
      ),
    ).rejects.toThrow("绝对路径");
    await expect(
      discoverSources(
        { home: root, cliPath: "/test/paseo" },
        dependencies([{ id: "broken" }]),
      ),
    ).rejects.toThrow();
  });
});

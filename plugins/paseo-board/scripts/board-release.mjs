#!/usr/bin/env node
// Repository CLI: npm ci supplies esbuild. Installed plugins use the compiled host RPCs.
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "board-release-cli-"));
try {
  const output = join(temporary, "release.cjs");
  await build({ absWorkingDir: pluginRoot, preserveSymlinks: true, entryPoints: [join(pluginRoot, "server/release-cli.ts")], outfile: output, bundle: true, platform: "node", format: "cjs", target: "node22", loader: { ".txt": "text" }, logLevel: "silent" });
  await createRequire(import.meta.url)(output).releaseMain(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Release command failed"}\n`); process.exitCode = 1;
} finally { await rm(temporary, { recursive: true, force: true }); }

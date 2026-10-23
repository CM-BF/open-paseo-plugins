// Regenerates the embedded text modules: node scripts/build-reference.mjs
//   docs/REFERENCE.md   -> server/reference.ts
//   workflows/<name>.js -> server/builtin-workflows.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const literal = (text) => `\`${text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")}\``;

const source = readFileSync(join(root, "docs", "REFERENCE.md"), "utf8");
writeFileSync(
  join(root, "server", "reference.ts"),
  `/**\n * The workflow authoring reference returned by the workflow_reference tool and written to\n * <state>/REFERENCE.md. Generated from docs/REFERENCE.md by scripts/build-reference.mjs; edit that file.\n */\nexport const REFERENCE = ${literal(source)};\n`,
);

const names = readdirSync(join(root, "workflows")).filter((file) => file.endsWith(".js")).sort();
const entries = names.map((file) => `  ${JSON.stringify(file.slice(0, -3))}: ${literal(readFileSync(join(root, "workflows", file), "utf8"))},`);
writeFileSync(
  join(root, "server", "builtin-workflows.ts"),
  `/**\n * Workflows that ship with the plugin, by name. Generated from workflows/<name>.js by\n * scripts/build-reference.mjs; edit those files.\n */\nexport const BUILTIN_WORKFLOWS: Readonly<Record<string, string>> = {\n${entries.join("\n")}\n};\n`,
);

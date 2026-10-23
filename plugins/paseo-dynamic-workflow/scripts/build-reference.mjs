// Regenerates the embedded text modules: node scripts/build-reference.mjs
//   docs/REFERENCE.md   -> server/reference.ts
//   workflows/<name>.js -> server/builtin-workflows.ts (with workflows/_shared.js inserted)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withShared } from "./inject-shared.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const literal = (text) => `\`${text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")}\``;

const source = readFileSync(join(root, "docs", "REFERENCE.md"), "utf8");
writeFileSync(
  join(root, "server", "reference.ts"),
  `/**\n * The workflow authoring reference returned by the workflow_reference tool and written to\n * <state>/REFERENCE.md. Generated from docs/REFERENCE.md by scripts/build-reference.mjs; edit that file.\n */\nexport const REFERENCE = ${literal(source)};\n`,
);

// workflows/_*.js are shared helpers, inserted into every built-in rather than shipped by name.
const shared = readFileSync(join(root, "workflows", "_shared.js"), "utf8");
const names = readdirSync(join(root, "workflows")).filter((file) => file.endsWith(".js") && !file.startsWith("_")).sort();
const entries = names.map((file) => `  ${JSON.stringify(file.slice(0, -3))}: ${literal(withShared(readFileSync(join(root, "workflows", file), "utf8"), shared))},`);
writeFileSync(
  join(root, "server", "builtin-workflows.ts"),
  `/**\n * Workflows that ship with the plugin, by name. Generated from workflows/<name>.js by\n * scripts/build-reference.mjs; edit those files.\n */\nexport const BUILTIN_WORKFLOWS: Readonly<Record<string, string>> = {\n${entries.join("\n")}\n};\n`,
);

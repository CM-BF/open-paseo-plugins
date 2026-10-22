// Regenerates server/reference.ts from docs/REFERENCE.md: node scripts/build-reference.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "docs", "REFERENCE.md"), "utf8");
const escaped = source.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
writeFileSync(
  join(root, "server", "reference.ts"),
  `/**\n * The workflow authoring reference returned by the workflow_reference tool and written to\n * <state>/REFERENCE.md. Generated from docs/REFERENCE.md by scripts/build-reference.mjs; edit that file.\n */\nexport const REFERENCE = \`${escaped}\`;\n`,
);

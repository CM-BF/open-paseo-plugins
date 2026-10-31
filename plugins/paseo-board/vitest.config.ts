import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Match the plugin compiler's inline text loader, including the standalone worker.
export default defineConfig({ plugins: [{ name: "board-text-assets", enforce: "pre", load(id) {
  if (id.endsWith(".txt")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
} }] });

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { referenceStatus, ULTRACODE_NOTICE } from "./prompts";
import { REFERENCE } from "./reference";

describe("REFERENCE", () => {
  it("is generated from docs/REFERENCE.md (run node scripts/build-reference.mjs)", () => {
    expect(REFERENCE).toBe(readFileSync(join(__dirname, "..", "docs", "REFERENCE.md"), "utf8"));
  });

  it("has every section the status lines and the Ultracode notice point to", () => {
    const headings = new Set([...REFERENCE.matchAll(/^#{2,3} (.+)$/gm)].map((match) => match[1]!.trim()));
    const texts = [
      referenceStatus({ ultracode: true, size: "unrestricted" }),
      referenceStatus({ ultracode: false, size: "unrestricted" }),
      referenceStatus({ ultracode: false, size: "large" }),
    ];
    for (const title of texts.flatMap((text) => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]!))) {
      expect(headings, title).toContain(title);
    }
    expect(ULTRACODE_NOTICE).toContain("Ultracode section of workflow_reference");
    expect(headings).toContain("Ultracode");
  });
});

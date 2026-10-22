import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REFERENCE } from "./reference";

describe("REFERENCE", () => {
  it("is generated from docs/REFERENCE.md (run node scripts/build-reference.mjs)", () => {
    expect(REFERENCE).toBe(readFileSync(join(__dirname, "..", "docs", "REFERENCE.md"), "utf8"));
  });
});

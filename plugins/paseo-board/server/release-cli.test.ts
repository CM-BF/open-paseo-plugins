import { expect, it } from "vitest";
import { releaseMain } from "./release-cli";

it("rejects misspelled GitHub host flags before a publication can fall back to github.com", async () => {
  for (const command of ["accounts", "repositories", "prepare", "publish"]) {
    await expect(releaseMain([command, "--host", "github.enterprise.example"]))
      .rejects.toThrow(`Unsupported argument --host for ${command}`);
    await expect(releaseMain([command, "--github-hots", "github.enterprise.example"]))
      .rejects.toThrow(`Unsupported argument --github-hots for ${command}`);
  }
});

it("refuses a replacement host on an existing immutable publication job", async () => {
  for (const command of ["merge", "refresh"]) {
    await expect(releaseMain([command, "--github-host", "github.enterprise.example"]))
      .rejects.toThrow(`Unsupported argument --github-host for ${command}`);
  }
});

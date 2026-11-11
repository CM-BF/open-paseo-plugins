import { describe, expect, it } from "vitest";
import type { GitHubRepository } from "../shared/release-contracts";
import { repositoryChoices } from "./repo-picker";

const repo = (name: string, personal = false): GitHubRepository => ({ name, private: false, url: `https://git.corp.example/${name}`, ...(personal ? { personal } : {}) });
const list = [repo("company/api"), repo("sgui/notes", true), repo("company/notes-service"), repo("sgui/site", true)];
const names = (items: GitHubRepository[]) => items.map(item => item.name);

describe("repository choices", () => {
  it("separates the account's own repositories from organization repositories", () => {
    const choices = repositoryChoices(list, "");
    expect(names(choices.personal)).toEqual(["sgui/notes", "sgui/site"]);
    expect(names(choices.others)).toEqual(["company/api", "company/notes-service"]);
    expect(choices).toMatchObject({ hidden: 0, noMatch: false });
  });
  it("filters by typed text, case-insensitively", () => {
    const choices = repositoryChoices(list, " NOTES ");
    expect(names(choices.personal)).toEqual(["sgui/notes"]);
    expect(names(choices.others)).toEqual(["company/notes-service"]);
  });
  it("keeps every option after an exact pick so another repository can be chosen", () => {
    const choices = repositoryChoices(list, "sgui/site");
    expect(choices.personal).toHaveLength(2);
    expect(choices.others).toHaveLength(2);
  });
  it("reports when nothing matches", () => {
    expect(repositoryChoices(list, "missing")).toMatchObject({ personal: [], others: [], hidden: 0, noMatch: true });
    expect(repositoryChoices([], "missing").noMatch).toBe(false);
  });
  it("spends the display limit on the account's own repositories first", () => {
    const many = [...Array.from({ length: 150 }, (_, index) => repo(`company/r${index}`)), repo("sgui/late", true)];
    const choices = repositoryChoices(many, "", 100);
    expect(names(choices.personal)).toEqual(["sgui/late"]);
    expect(choices.others).toHaveLength(99);
    expect(choices.hidden).toBe(51);
  });
});

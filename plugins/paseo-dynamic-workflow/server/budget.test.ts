import { describe, expect, it } from "vitest";
import { parseBudgetDirective } from "./budget";

describe("parseBudgetDirective", () => {
  it.each([
    ["audit this +500k", 500_000],
    ["+2m please", 2_000_000],
    ["go +1.5M!", 1_500_000],
    ["spend 800k tokens on it", 800_000],
    ["use 2M tokens", 2_000_000],
    ["no budget here", null],
    ["a+5k typo", null],
    ["use 3 tokens", null],
    ["review +2k lines changed", null],
    ["stats (+1.5k/-300)", null],
    ["review +3k LOC carefully", null],
    ["use 3000 tokens", null],
  ])("%s", (text, expected) => {
    expect(parseBudgetDirective(text)).toBe(expected);
  });
});

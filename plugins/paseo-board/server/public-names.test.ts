import { describe, expect, it } from "vitest";
import { forbiddenPublicName as pluginRule } from "../shared/inbox";
import { PUBLIC_COMMENTS_SHELL } from "../shared/public-threads";
// @ts-expect-error JavaScript runtime module.
import { forbiddenPublicName as backendRule } from "../backend/threads.mjs";
// @ts-expect-error JavaScript test module.
import { forbiddenPublicName as fakeRule } from "../scripts/comments-fake-backend.mjs";

/*
 * The public name rule exists four times: the backend (POST), the plugin's import, the page's composer (badName in the
 * public shell) and the browser tests' fake backend. They must agree, including the look-alike and variation-selector
 * cases of the merge review (Cyrillic А, Greek Α Ι, a single U+FE00 or U+034F inside a label).
 */
const viewerLine = PUBLIC_COMMENTS_SHELL.split("\n").find(line => line.trim().startsWith("const badName="));
// Test only: the shell's own source line, evaluated in isolation.
const viewerRule = new Function(`${viewerLine}; return badName;`)() as (name: string) => boolean;
const REFUSED = ["作者", "作 者", "ＡＩ助手", "ai 助手", "訪客", "访客小王", "АI 助手", "аi助手", "ΑΙ 助手", "αι助手", "作︀者", "AI 助︀手", "作͏者", "Al 助手", "A1 助手", "A| 助手", "访\u{E0100}客", "x​y"];
const ALLOWED = ["迈克尔·杰克逊", "Author", "博主", "小王", "小王❤️", "Ali", "Alice 的助理", "Lily"];

describe("public names (merge review: look-alikes and single variation selectors)", () => {
  it("the four copies of the rule agree and refuse the page labels written with look-alikes or hidden marks", () => {
    expect(viewerLine).toBeDefined();
    for (const rule of [pluginRule, backendRule, fakeRule, viewerRule] as Array<(name: string) => boolean>) {
      for (const name of REFUSED) expect(rule(name), JSON.stringify(name)).toBe(true);
      for (const name of ALLOWED) expect(rule(name), JSON.stringify(name)).toBe(false);
    }
  });
});

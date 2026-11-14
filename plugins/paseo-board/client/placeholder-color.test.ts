import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every panel input with a placeholder uses the theme's muted colour (lockdown design §4 item 6). */
describe("TextInput placeholders", () => {
  it("set placeholderTextColor wherever a placeholder is shown", () => {
    const dir = join(__dirname);
    const missing: string[] = [];
    let checked = 0;
    for (const name of readdirSync(dir).filter(file => file.endsWith(".tsx"))) {
      const source = readFileSync(join(dir, name), "utf8");
      // TextInputs are self-closing; attributes may contain arrow functions, so scan to the next "/>".
      for (let at = source.indexOf("<TextInput"); at >= 0; at = source.indexOf("<TextInput", at + 1)) {
        const element = source.slice(at, source.indexOf("/>", at) + 2);
        if (/\bplaceholder=/.test(element) && !/\bplaceholderTextColor=/.test(element)) missing.push(`${name}: ${element.slice(0, 80)}`);
        checked++;
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(5);
    expect(readFileSync(join(dir, "release-panel.tsx"), "utf8")).toContain('placeholder="https://api.example.internal" placeholderTextColor={c.foregroundMuted}');
  });
});

import type { MemoryTarget } from "./contracts";

const TARGET_PREFIXES: ReadonlyArray<readonly [RegExp, MemoryTarget]> = [
  [/^(user|me|profile|用户|我)\s*[:：]\s*/i, "user"],
  [/^(project|repo|项目|仓库)\s*[:：]\s*/i, "project"],
  [/^(memory|env|environment|记忆|环境)\s*[:：]\s*/i, "memory"],
];

/** `/remember project: tests run with npm test` → target and text. */
export function parseRemember(args: string): { target: MemoryTarget; text: string } {
  for (const [re, target] of TARGET_PREFIXES) {
    if (re.test(args)) return { target, text: args.replace(re, "").trim() };
  }
  return { target: "memory", text: args.trim() };
}

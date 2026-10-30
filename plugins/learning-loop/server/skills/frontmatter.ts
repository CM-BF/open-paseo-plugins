// Minimal YAML frontmatter reader for SKILL.md: top-level `key: value` pairs, quoted scalars and
// `|` / `>` block scalars. Nested maps (metadata.hermes.*) are skipped; the library does not need them.

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
  present: boolean;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner.replace(/''/g, "'");
  }
  return v;
}

export function parseFrontmatter(text: string): Frontmatter {
  const content = text.replace(/^﻿/, "");
  if (!content.startsWith("---")) return { fields: {}, body: content, present: false };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { fields: {}, body: content, present: false };
  const header = content.slice(3, end).replace(/^\r?\n/, "");
  const afterFence = content.indexOf("\n", end + 4);
  const body = afterFence === -1 ? "" : content.slice(afterFence + 1);
  const fields: Record<string, string> = {};
  const lines = header.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const rest = match[2]!;
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]!) || lines[index + 1] === "")) {
        index += 1;
        block.push(lines[index]!.trim());
      }
      fields[key] = rest.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
      continue;
    }
    if (rest === "") continue; // a nested map
    fields[key] = unquote(rest);
  }
  return { fields, body, present: true };
}

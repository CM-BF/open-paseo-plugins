// Prompt-injection / promptware / exfiltration patterns for text that ends up in a system prompt
// (memory entries, skills). Ported from Hermes tools/threat_patterns.py. Scopes are cumulative:
// "all" ⊂ "context" ⊂ "strict"; memory and skill writes use "strict" (a block is resolvable there).
// New patterns anchor on C2 vocabulary or unambiguous attack behavior, never bossy English.

export type ThreatScope = "all" | "context" | "strict";

const MAX_SCAN_CHARS = 65_536;
const FILLER = String.raw`(?:\w+\s+){0,8}`;
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`;
const MODIFY = String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}`;

const PATTERNS: ReadonlyArray<readonly [string, string, ThreatScope]> = [
  [String.raw`ignore\s+${FILLER}(previous|all|above|prior)\s+${FILLER}instructions`, "prompt_injection", "all"],
  [String.raw`system\s+prompt\s+override`, "sys_prompt_override", "all"],
  [String.raw`disregard\s+${FILLER}(your|all|any)\s+${FILLER}(instructions|rules|guidelines)`, "disregard_rules", "all"],
  [
    String.raw`act\s+as\s+(if|though)\s+${FILLER}you\s+${FILLER}(have\s+no|don't\s+have)\s+${FILLER}(restrictions|limits|rules)`,
    "bypass_restrictions",
    "all",
  ],
  [String.raw`<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->`, "html_comment_injection", "all"],
  [String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`, "hidden_div", "all"],
  [String.raw`translate\s+[^\n]{0,512}\s+into\s+\w+(?:[\s-]+\w+){0,2}\s+and\s+(execute|run|eval)\b`, "translate_execute", "all"],
  [String.raw`do\s+not\s+${FILLER}tell\s+${FILLER}the\s+user`, "deception_hide", "all"],

  [String.raw`you\s+are\s+${FILLER}now\s+(?:a|an|the)\s+`, "role_hijack", "context"],
  [String.raw`pretend\s+${FILLER}(you\s+are|to\s+be)\s+`, "role_pretend", "context"],
  [String.raw`output\s+${FILLER}(system|initial)\s+prompt`, "leak_system_prompt", "context"],
  [String.raw`(respond|answer|reply)\s+without\s+${FILLER}(restrictions|limitations|filters|safety)`, "remove_filters", "context"],
  [String.raw`you\s+have\s+been\s+${FILLER}(updated|upgraded|patched)\s+to`, "fake_update", "context"],
  [String.raw`\bname\s+yourself\s+\w+`, "identity_override", "context"],
  [String.raw`register\s+(as\s+)?a?\s*node`, "c2_node_registration", "context"],
  [String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`, "c2_heartbeat", "context"],
  [String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, "c2_task_pull", "context"],
  [String.raw`connect\s+to\s+the\s+network\b`, "c2_network_connect", "context"],
  [String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`, "forced_action", "context"],
  [String.raw`only\s+use\s+one[\s\-]?liners?\b`, "anti_forensic_oneliner", "context"],
  [String.raw`never\s+${FILLER}(?:create|write)\s+${FILLER}(?:script|file)\s+${FILLER}disk`, "anti_forensic_disk", "context"],
  [String.raw`unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC|PASEO)\w*`, "env_var_unset_agent", "context"],
  [String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`, "known_c2_framework", "context"],
  [String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`, "c2_explicit", "context"],
  [String.raw`\bcommand\s+and\s+control\b`, "c2_explicit_long", "context"],

  [String.raw`curl\s+[^\n]{0,2048}${SECRET_VAR}`, "exfil_curl", "all"],
  [String.raw`wget\s+[^\n]{0,2048}${SECRET_VAR}`, "exfil_wget", "all"],
  [String.raw`cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`, "read_secrets", "all"],
  [String.raw`(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?://`, "send_to_url", "strict"],
  [
    String.raw`(include|output|print|share)\s+${FILLER}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`,
    "context_exfil",
    "strict",
  ],
  [String.raw`authorized_keys`, "ssh_backdoor", "strict"],
  [
    String.raw`(?:\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\b|\bopen\s*\(|>>?)[^\n]{0,512}(?:\$HOME/\.ssh|~/\.ssh)`,
    "ssh_access",
    "strict",
  ],
  [String.raw`${MODIFY}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`, "agent_config_mod", "strict"],
  [String.raw`${MODIFY}\.paseo/(config\.json|plugin-settings)`, "paseo_config_mod", "strict"],
];

/** Credential-looking assignment; the value check below skips env-var NAMES (SHOUTY_SNAKE). */
const HARDCODED_SECRET = /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']([A-Za-z0-9+/=_-]{20,})/gi;
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Zero-width and bidirectional controls used to hide text from humans. */
export const INVISIBLE_CHARS = new Set([
  "​", "‌", "‍", "⁠", "⁢", "⁣", "⁤", "﻿",
  "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩",
]);

const SCOPES: Record<ThreatScope, readonly ThreatScope[]> = {
  all: ["all", "context", "strict"],
  context: ["context", "strict"],
  strict: ["strict"],
};

const COMPILED: Record<ThreatScope, Array<readonly [RegExp, string]>> = { all: [], context: [], strict: [] };
for (const [source, id, scope] of PATTERNS) {
  for (const target of SCOPES[scope]) COMPILED[target].push([new RegExp(source, "i"), id] as const);
}

/** Matched pattern ids; invisible codepoints are reported as `invisible_unicode_U+XXXX`. */
export function scanForThreats(content: string, scope: ThreatScope = "context"): string[] {
  if (!content) return [];
  const text = content.slice(0, MAX_SCAN_CHARS);
  const findings: string[] = [];
  for (const ch of new Set(text)) {
    if (INVISIBLE_CHARS.has(ch)) findings.push(`invisible_unicode_U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  // NFKC folds full-width / compatibility variants against homograph bypass.
  const normalised = text.normalize("NFKC");
  for (const [pattern, id] of COMPILED[scope]) if (pattern.test(normalised)) findings.push(id);
  if (scope === "strict") {
    for (const match of normalised.matchAll(HARDCODED_SECRET)) {
      if (!ENV_NAME.test(match[1]!)) {
        findings.push("hardcoded_secret");
        break;
      }
    }
  }
  return findings;
}

/** User-facing refusal for the first finding, or null. */
export function firstThreatMessage(content: string, scope: ThreatScope = "strict"): string | null {
  const [first] = scanForThreats(content, scope);
  if (!first) return null;
  if (first.startsWith("invisible_unicode_")) {
    return `Blocked: content contains invisible unicode character ${first.replace("invisible_unicode_", "")} (possible injection).`;
  }
  return (
    `Blocked: content matches threat pattern '${first}'. Content is injected into agents' system prompts ` +
    "and must not contain injection or exfiltration payloads."
  );
}

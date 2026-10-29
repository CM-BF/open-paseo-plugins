// Credential-shaped text is replaced before a transcript digest leaves this process (review runs).

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g, "[REDACTED KEY]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED TOKEN]"],
  [/\b(xox[abprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED TOKEN]"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[REDACTED KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED JWT]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1[REDACTED]"],
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[REDACTED]@"],
  [
    /\b([A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*\s*[=:]\s*)(["']?)[^\s"']{8,}\2/gi,
    "$1$2[REDACTED]$2",
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The token target of a user message: "+500k", "+2m", "+1.5M", "spend 2M tokens", "use 800k tokens".
 * Returns null when the message sets none. Only the user's own message counts: tool input,
 * meta and configuration cannot set a budget.
 */
export function parseBudgetDirective(text: string | null | undefined): number | null {
  if (!text) return null;
  const unit = (suffix: string | undefined): number => {
    switch ((suffix ?? "").toLowerCase()) {
      case "k":
        return 1_000;
      case "m":
        return 1_000_000;
      case "b":
        return 1_000_000_000;
      default:
        return 1;
    }
  };
  const plus = /(?:^|[\s(])\+(\d+(?:\.\d+)?)\s*([kmb])\b/i.exec(text);
  if (plus) return Math.round(Number(plus[1]) * unit(plus[2]));
  const verbal = /\b(?:spend|use|budget(?:\s+of)?)\s+(?:up\s+to\s+)?(\d+(?:\.\d+)?)\s*([kmb])?\s*tokens?\b/i.exec(text);
  if (verbal) {
    const value = Math.round(Number(verbal[1]) * unit(verbal[2]));
    return value >= 1000 ? value : null;
  }
  return null;
}

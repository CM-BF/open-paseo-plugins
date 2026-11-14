/**
 * Models the sealed comment runner can use, with Claude API list prices (lockdown design §3.5).
 *
 * Prices are USD per million tokens from the Claude API model table cached 2026-11-03 (Haiku 5.5's price is for
 * prompts up to 100K tokens; a run stays far below that). With a Claude subscription the runs count against the
 * subscription instead. Estimates are upper bounds without prompt caching; the panel replaces them with the
 * measured average once runs have reported `total_cost_usd`.
 */
export const PRICE_TABLE_DATE = "2026-11";

export type ModelFamily = "haiku" | "sonnet" | "opus";
export interface ModelPrice {
  id: string; family: ModelFamily; label: string;
  inputPerMTok: number; outputPerMTok: number;
  /** Whether `--effort` applies (Haiku 4.5 rejects it). */
  effort: boolean;
  /** Default daily cost cap per Board. */
  dailyCapUsd: number;
}
export const MODEL_PRICES: readonly ModelPrice[] = [
  { id: "claude-haiku-5-5", family: "haiku", label: "Haiku 5.5", inputPerMTok: 0.1, outputPerMTok: 0.5, effort: true, dailyCapUsd: 0.5 },
  { id: "claude-haiku-4-5", family: "haiku", label: "Haiku 4.5", inputPerMTok: 1, outputPerMTok: 5, effort: false, dailyCapUsd: 2 },
  { id: "claude-sonnet-5-5", family: "sonnet", label: "Sonnet 5.5", inputPerMTok: 2, outputPerMTok: 10, effort: true, dailyCapUsd: 5 },
  { id: "claude-opus-5-5", family: "opus", label: "Opus 5.5", inputPerMTok: 4, outputPerMTok: 20, effort: true, dailyCapUsd: 10 },
];
/** CLI aliases, used when the provider's model list cannot be read; priced as the current model of the family. */
export const ALIAS_PRICES: readonly ModelPrice[] = [
  { ...MODEL_PRICES[0], id: "haiku", label: "Haiku" },
  { ...MODEL_PRICES[2], id: "sonnet", label: "Sonnet" },
  { ...MODEL_PRICES[3], id: "opus", label: "Opus" },
];
/** The most expensive known price: the budget of a run on a model without a price. */
const FALLBACK_PRICE = MODEL_PRICES[3];
export const UNPRICED_DAILY_CAP_USD = 10;

export const priceOf = (id: string): ModelPrice | undefined => MODEL_PRICES.find(model => model.id === id) ?? ALIAS_PRICES.find(model => model.id === id);
/** The family a model id or alias belongs to (`claude-haiku-5-5-20261001` → haiku). */
export function familyOf(id: string): ModelFamily | null {
  const match = /(?:^|[-/])(haiku|sonnet|opus)(?:$|[-[])/.exec(id.toLowerCase());
  return match ? match[1] as ModelFamily : null;
}

/**
 * Upper-bound cost of one run with `n` comments: about 2n+1 requests, the context growing about 1.5k tokens per
 * step from a 4k base (system prompt, four tool schemas, the IDs-only prompt), and 400 output tokens per request
 * including low-effort thinking.
 */
export function estimateRun(price: Pick<ModelPrice, "inputPerMTok" | "outputPerMTok">, n: number): number {
  const comments = Math.max(1, Math.min(8, Math.floor(n)));
  const requests = 2 * comments + 1;
  const input = requests * (4_000 + 1_500 * comments), output = requests * 400;
  return (input * price.inputPerMTok + output * price.outputPerMTok) / 1_000_000;
}
/** Per comment: a single-comment run and a full 8-comment run (a lower and an upper figure). */
export function perComment(price: Pick<ModelPrice, "inputPerMTok" | "outputPerMTok">): { lo: number; hi: number } {
  const one = estimateRun(price, 1), eight = estimateRun(price, 8) / 8;
  return { lo: Math.min(one, eight), hi: Math.max(one, eight) };
}
/** `--max-budget-usd` of a run: max($0.02, 2 × the upper estimate); unpriced models are budgeted like Opus. */
export function perRunCap(id: string, n: number): number {
  return Math.max(0.02, 2 * estimateRun(priceOf(id) ?? FALLBACK_PRICE, n));
}
/** The preflight's budget: one short turn with the full system prompt and tool schemas. */
export const PREFLIGHT_BUDGET_USD = 0.1;

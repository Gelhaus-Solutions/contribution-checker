import { env } from "@/lib/env";
import type { AiTier, AiUsage } from "@/lib/ai/types";

/**
 * Model routing and cost accounting.
 *
 * Two tiers rather than one model, because the four AI tasks are not the same
 * kind of work. Triage, QA steps and the quality signal are short-context,
 * constrained-JSON classification, where a small model is close to a large one.
 * The release narrative is the only task doing real synthesis over a large diff,
 * and it runs about a hundred times a year, so it can afford the good model.
 */

/** Resolve the model slug for a tier. Both are env-overridable per environment. */
export function modelFor(tier: AiTier): string {
  return tier === "judgment" ? env.AI_MODEL_JUDGMENT : env.AI_MODEL_CHEAP;
}

/**
 * Dollars per million tokens, as published by OpenRouter.
 *
 * A FALLBACK only. The client prefers the cost OpenRouter reports on the
 * response, because a single model slug is served by many providers at prices
 * differing by an order of magnitude (gpt-oss-120b ranges from $0.030 to $0.350
 * per 1M input depending on who answers), and we do not choose the route. This
 * table is what we fall back to when a response carries no usage accounting.
 *
 * An unknown model records zero rather than a guess. Token counts stay accurate
 * either way because they come off the response. Treat the money column as
 * indicative and the provider dashboard as authoritative, especially under BYOK
 * where OpenRouter reports zero because the upstream provider did the billing.
 *
 * `cachedIn` is the rate for prompt tokens that hit the provider's cache, about
 * a tenth of fresh input. It is the whole reason prompt.ts keeps a stable
 * prefix, so it is worth recording separately rather than folding into `in`.
 */
type Price = { in: number; out: number; cachedIn: number };

// Note the 2.5 entries are priced but effectively uncallable: Google retired
// that line for new users, so a BYOK key gets a 404 pointing at 3.5-flash-lite.
// They stay listed because a run recorded before the cutoff still needs pricing,
// and because OpenRouter's own credits may still route them.
const PRICES: Record<string, Price> = {
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4, cachedIn: 0.01 },
  "google/gemini-2.5-flash": { in: 0.3, out: 2.5, cachedIn: 0.03 },
  "google/gemini-3.1-flash-lite": { in: 0.25, out: 1.5, cachedIn: 0.025 },
  "google/gemini-3.5-flash-lite": { in: 0.3, out: 2.5, cachedIn: 0.03 },
  "google/gemini-3.5-flash": { in: 1.5, out: 9.0, cachedIn: 0.15 },
  "google/gemini-3.6-flash": { in: 0.75, out: 3.75, cachedIn: 0.075 },
  "google/gemini-3.7-flash": { in: 0.75, out: 3.75, cachedIn: 0.075 },
  // Batch variants run asynchronously at roughly half price. Not used by the
  // interactive paths (someone is watching a spinner), but the opt-in automatic
  // runs are a natural fit for them later.
  "google/gemini-2.5-flash-lite:batch": { in: 0.05, out: 0.2, cachedIn: 0.01 },
  "google/gemini-2.5-flash:batch": { in: 0.15, out: 1.25, cachedIn: 0.03 },
  "google/gemini-3.5-flash-lite:batch": { in: 0.15, out: 1.25, cachedIn: 0.015 },
  "google/gemini-3.7-flash:batch": { in: 0.1875, out: 0.9375, cachedIn: 0.01875 },
  // OpenAI's open-weight models. Roughly an order of magnitude below the Gemini
  // Flash tier, which is why they are candidates for the cheap tier. Note the
  // batch variant is *more* expensive here, the opposite of Gemini's: batch
  // pricing is per-provider and cannot be assumed to be a discount.
  "openai/gpt-oss-120b": { in: 0.037, out: 0.17, cachedIn: 0.0037 },
  "openai/gpt-oss-120b:batch": { in: 0.15, out: 0.6, cachedIn: 0.015 },
  "openai/gpt-oss-20b": { in: 0.03, out: 0.13, cachedIn: 0.003 },
  "openai/gpt-oss-safeguard-20b": { in: 0.075, out: 0.3, cachedIn: 0.0075 },
};

/**
 * Cost of one call in millionths of a dollar.
 *
 * Integer micros rather than a float in dollars: these get summed across
 * thousands of rows to answer "what did this project spend", and repeated
 * float addition of numbers around 1e-4 loses precision in a way that is
 * annoying to explain to somebody reading a bill.
 *
 * Cached prompt tokens are billed at the cache rate, so they are subtracted out
 * of the fresh-input count rather than double-counted.
 */
export function costMicrosFor(args: {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}): number {
  const p = PRICES[args.model];
  if (!p) return 0;
  const fresh = Math.max(0, args.promptTokens - args.cachedTokens);
  const dollars =
    (fresh * p.in + args.cachedTokens * p.cachedIn + args.completionTokens * p.out) /
    1_000_000;
  return Math.round(dollars * 1_000_000);
}

/** Format micros for display, e.g. 1234 -> "$0.0012". */
export function formatCost(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

/** True when we can price this model at all, for UI that wants to say so. */
export function isPricedModel(model: string): boolean {
  return model in PRICES;
}

/** Zero usage, for the paths that record a run without having called anything. */
export const NO_USAGE: AiUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  costMicros: 0,
};

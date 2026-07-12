// Pure merge + verdict logic behind get_price_history, extracted so the buy/wait
// gating and the CCC-vs-local merge are unit-testable without a server or network.

import type { PriceHistory } from "../types.js";

export interface LoggedPrice {
  /** ISO timestamp (or date) the price was recorded, newest first in the log. */
  date: string;
  price: number;
}

export interface PriceAnalysis {
  current: number | null;
  /**
   * Date (YYYY-MM-DD) of the log row `current` was taken from, when it did NOT come
   * from a live fetch or CCC — i.e. when "current" is really "last seen". Null when
   * the price is actually current.
   */
  currentAsOf: string | null;
  lowest: number | null;
  highest: number | null;
  average: number | null;
  dropFromHighPct: number | null;
  verdict: string;
  source: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function minNonNull(...xs: Array<number | null | undefined>): number | null {
  const vals = xs.filter((x): x is number => x != null);
  return vals.length ? Math.min(...vals) : null;
}

function maxNonNull(...xs: Array<number | null | undefined>): number | null {
  const vals = xs.filter((x): x is number => x != null);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * Merge a live price, best-effort CCC data and the local price log into the numbers
 * and the human verdict get_price_history reports.
 *
 * Merge rule: extremes COMBINE across sources (min of lowests, max of highests) — a
 * "prefer CCC" merge would let the verdict say "lowest ever, buy now" while the local
 * log printed right below it shows a cheaper price. Average prefers CCC (longer
 * baseline), else local.
 *
 * Verdict gating: strong buy/wait calls need real support — CCC data, or ≥4 local
 * points. A local-only history that never moved reports price stability (with its
 * as-of date when the "current" price is itself from the log) instead of the
 * trivially-true "at the lowest price ever".
 */
export function analyzePriceHistory(opts: {
  /** Price fetched live from Amazon just now; null when blocked/unavailable. */
  livePrice: number | null;
  /** CCC result, already normalized to null when it carried no data. */
  ccc: PriceHistory | null;
  /** Local price log, newest first. */
  log: LoggedPrice[];
  /** Renders an amount for embedding in the verdict text. */
  formatMoney: (n: number) => string;
}): PriceAnalysis {
  const { livePrice, ccc, log, formatMoney } = opts;

  const prices = log.map((p) => p.price);
  const localLowest = prices.length ? Math.min(...prices) : null;
  const localHighest = prices.length ? Math.max(...prices) : null;
  const localAvg = prices.length ? round2(prices.reduce((x, y) => x + y, 0) / prices.length) : null;

  const current = livePrice ?? ccc?.current ?? log[0]?.price ?? null;
  const currentAsOf =
    livePrice == null && ccc?.current == null && log[0] != null ? log[0].date.slice(0, 10) : null;

  const lowest = minNonNull(ccc?.lowest, localLowest);
  const highest = maxNonNull(ccc?.highest, localHighest);
  const average = ccc?.average ?? localAvg;
  const source = ccc ? "camelcamelcamel + local" : "local price tracking";
  const dropFromHighPct =
    current != null && highest != null && highest > 0 ? Math.round((1 - current / highest) * 1000) / 10 : null;

  const points = prices.length;
  const distinctPrices = new Set(prices).size;
  const hasSupport = ccc != null || points >= 4;
  const flatLocalOnly = ccc == null && distinctPrices <= 1;

  const asOfNote = currentAsOf ? ` (as of ${currentAsOf})` : "";

  let verdict: string;
  if (current == null) verdict = "Current price unknown (Amazon page blocked or unavailable).";
  else if (!hasSupport)
    verdict = "Not enough history yet — check this product again over the next few days to build a trend.";
  else if (flatLocalOnly)
    verdict = `The tracked price has held steady at ${formatMoney(current)} over ${points} checks${asOfNote} — no drop yet.`;
  else if (lowest != null && current <= lowest * 1.01)
    verdict = "At or near the lowest tracked price — great time to buy.";
  else if (average != null && current < average * 0.9) verdict = "Below average — good deal.";
  else if (average != null && current > average * 1.1) verdict = "Above average — consider waiting.";
  else if (average != null) verdict = "Around the average price.";
  else verdict = "Not enough history yet — check this product again over the next few days to build a trend.";

  return { current, currentAsOf, lowest, highest, average, dropFromHighPct, verdict, source };
}

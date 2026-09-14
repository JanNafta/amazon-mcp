import { describe, expect, it } from "vitest";

import { analyzePriceHistory } from "../src/lib/price-analysis.js";
import type { PriceHistory } from "../src/types.js";

const fmt = (n: number) => `${n.toFixed(2)} USD`;

function ccc(partial: Partial<PriceHistory>): PriceHistory {
  return {
    asin: "B000000000",
    marketplace: "US",
    currency: "USD",
    current: null,
    lowest: null,
    lowestDate: null,
    highest: null,
    highestDate: null,
    average: null,
    dropFromHighPct: null,
    verdict: "",
    source: "camelcamelcamel",
    chartUrl: null,
    ...partial,
  };
}

const day = (d: string, price: number) => ({ date: `${d}T12:00:00.000Z`, price });

describe("analyzePriceHistory — CCC-vs-local extreme merging (min/max, not ??)", () => {
  it("takes the LOCAL lowest when it undercuts CCC's lowest", () => {
    // Regression: with a prefer-CCC merge, the verdict said "lowest ever — buy now"
    // while the printed local log showed a cheaper price days earlier.
    const a = analyzePriceHistory({
      livePrice: 30,
      ccc: ccc({ current: 30, lowest: 30, highest: 60, average: 45 }),
      log: [day("2026-07-05", 28), day("2026-07-01", 25)],
      formatMoney: fmt,
    });
    expect(a.lowest).toBe(25);
    expect(a.verdict).not.toContain("great time to buy");
  });

  it("takes the LOCAL highest when it exceeds CCC's highest (and drop % uses it)", () => {
    const a = analyzePriceHistory({
      livePrice: 60,
      ccc: ccc({ current: 60, lowest: 40, highest: 60, average: 50 }),
      log: [day("2026-07-05", 80)],
      formatMoney: fmt,
    });
    expect(a.highest).toBe(80);
    expect(a.dropFromHighPct).toBe(25);
  });

  it("uses CCC extremes when they are the true extremes", () => {
    const a = analyzePriceHistory({
      livePrice: 50,
      ccc: ccc({ current: 50, lowest: 20, highest: 90, average: 50 }),
      log: [day("2026-07-05", 50)],
      formatMoney: fmt,
    });
    expect(a.lowest).toBe(20);
    expect(a.highest).toBe(90);
  });

  it("average prefers CCC, falls back to the local mean", () => {
    const withCcc = analyzePriceHistory({
      livePrice: 10,
      ccc: ccc({ current: 10, lowest: 5, highest: 20, average: 12 }),
      log: [day("2026-07-01", 10)],
      formatMoney: fmt,
    });
    expect(withCcc.average).toBe(12);

    const localOnly = analyzePriceHistory({
      livePrice: 10,
      ccc: null,
      log: [day("2026-07-04", 10), day("2026-07-03", 20), day("2026-07-02", 30), day("2026-07-01", 40)],
      formatMoney: fmt,
    });
    expect(localOnly.average).toBe(25);
  });
});

describe("analyzePriceHistory — verdict gating", () => {
  it("first-ever lookup (1 self-recorded point) never claims 'great time to buy'", () => {
    const a = analyzePriceHistory({
      livePrice: 19.99,
      ccc: null,
      log: [day("2026-07-12", 19.99)],
      formatMoney: fmt,
    });
    expect(a.verdict).toContain("Not enough history");
  });

  it("a stable price eventually clears the gate (points, not distinct values) and reports stability", () => {
    // 5 same-price points across 5 days: enough points, but flat → honest stability
    // report, not a fabricated buy/wait call and not a stuck "not enough history".
    const log = ["2026-07-12", "2026-07-11", "2026-07-10", "2026-07-09", "2026-07-08"].map((d) => day(d, 19.99));
    const a = analyzePriceHistory({ livePrice: 19.99, ccc: null, log, formatMoney: fmt });
    expect(a.verdict).toContain("held steady at 19.99 USD");
    expect(a.verdict).toContain("5 checks");
  });

  it("4+ points with movement produce a real buy/wait verdict", () => {
    const a = analyzePriceHistory({
      livePrice: 25,
      ccc: null,
      log: [day("2026-07-12", 25), day("2026-07-10", 40), day("2026-07-08", 45), day("2026-07-06", 50)],
      formatMoney: fmt,
    });
    expect(a.verdict).toContain("great time to buy");
  });

  it("CCC data alone counts as support", () => {
    const a = analyzePriceHistory({
      livePrice: 100,
      ccc: ccc({ current: 100, lowest: 50, highest: 120, average: 80 }),
      log: [],
      formatMoney: fmt,
    });
    expect(a.verdict).toContain("Above average");
  });

  it("no data at all → current unknown", () => {
    const a = analyzePriceHistory({ livePrice: null, ccc: null, log: [], formatMoney: fmt });
    expect(a.current).toBeNull();
    expect(a.verdict).toContain("Current price unknown");
  });
});

describe("analyzePriceHistory — stale 'current' honesty", () => {
  it("marks currentAsOf when the price comes from the log (Amazon + CCC unavailable)", () => {
    const a = analyzePriceHistory({
      livePrice: null,
      ccc: null,
      log: [day("2026-06-15", 19.99)],
      formatMoney: fmt,
    });
    expect(a.current).toBe(19.99);
    expect(a.currentAsOf).toBe("2026-06-15");
  });

  it("the flat-price verdict carries the as-of date when the current price is stale", () => {
    const log = ["2026-06-15", "2026-06-14", "2026-06-13", "2026-06-12", "2026-06-11"].map((d) => day(d, 19.99));
    const a = analyzePriceHistory({ livePrice: null, ccc: null, log, formatMoney: fmt });
    expect(a.verdict).toContain("(as of 2026-06-15)");
  });

  it("does NOT mark currentAsOf when the price is live", () => {
    const a = analyzePriceHistory({
      livePrice: 10,
      ccc: null,
      log: [day("2026-06-15", 12)],
      formatMoney: fmt,
    });
    expect(a.currentAsOf).toBeNull();
  });

  it("does NOT mark currentAsOf when the price comes from CCC", () => {
    const a = analyzePriceHistory({
      livePrice: null,
      ccc: ccc({ current: 33, lowest: 30, highest: 40, average: 35 }),
      log: [day("2026-06-15", 12)],
      formatMoney: fmt,
    });
    expect(a.current).toBe(33);
    expect(a.currentAsOf).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addWatch,
  closeDb,
  getOrFetch,
  getPriceLog,
  isNonEmpty,
  listWatches,
  logPrice,
  updateWatchPrice,
} from "../src/lib/cache.js";

let dbPath = "";

beforeEach(() => {
  // Close any DB opened by a previous test BEFORE stubbing the new path, so the
  // next getDb() re-resolves the (freshly stubbed) AMAZON_CACHE_DB_PATH.
  closeDb();
  dbPath = join(tmpdir(), `amzedge-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  vi.stubEnv("AMAZON_CACHE_DB_PATH", dbPath);
});

afterEach(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {
        /* ignore */
      }
    }
  }
  vi.unstubAllEnvs();
});

describe("getOrFetch with shouldCache guard", () => {
  it("does NOT cache a value rejected by shouldCache, so the fetcher re-runs", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return { attempt: calls };
    });
    const rejectAll = () => false;

    const first = await getOrFetch("guard-reject", 3600, fetcher, rejectAll);
    expect(first).toEqual({ attempt: 1 });

    const second = await getOrFetch("guard-reject", 3600, fetcher, rejectAll);
    // Not served from cache — the fetcher ran again and produced a NEW value.
    expect(second).toEqual({ attempt: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("with isNonEmpty: an empty array is retried, a non-empty array is cached", async () => {
    let calls = 0;
    const fetcher = vi.fn(async (): Promise<string[]> => {
      calls++;
      // First attempt fails (empty result), subsequent attempts succeed.
      return calls === 1 ? [] : [`result-${calls}`];
    });

    const first = await getOrFetch("guard-empty", 3600, fetcher, isNonEmpty);
    expect(first).toEqual([]); // failure-shaped value is still RETURNED, just not cached

    const second = await getOrFetch("guard-empty", 3600, fetcher, isNonEmpty);
    expect(second).toEqual(["result-2"]); // fetcher re-ran because [] was not cached
    expect(fetcher).toHaveBeenCalledTimes(2);

    const third = await getOrFetch("guard-empty", 3600, fetcher, isNonEmpty);
    expect(third).toEqual(["result-2"]); // now served from cache
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("defaults to caching everything when no shouldCache is given (even [])", async () => {
    const fetcher = vi.fn(async (): Promise<number[]> => []);
    await getOrFetch("no-guard", 3600, fetcher);
    const again = await getOrFetch("no-guard", 3600, fetcher);
    expect(again).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("isNonEmpty predicate", () => {
  it("classifies arrays, null-ish, objects and primitives correctly", () => {
    expect(isNonEmpty([])).toBe(false);
    expect(isNonEmpty(["x"])).toBe(true);
    expect(isNonEmpty(null)).toBe(false);
    expect(isNonEmpty(undefined)).toBe(false); // == null also catches undefined
    expect(isNonEmpty({})).toBe(true); // non-array object counts as non-empty
    expect(isNonEmpty("")).toBe(true); // strings are not inspected for emptiness
    expect(isNonEmpty(0)).toBe(true); // falsy primitives are still "real" values
  });
});

describe("updateWatchPrice re-arming", () => {
  it("un-triggers when the price rises back above the target", () => {
    const w = addWatch("B0REARM01", "US", 100);

    updateWatchPrice(w.id, 90); // drop below target → triggered
    let reloaded = listWatches().find((x) => x.id === w.id);
    expect(reloaded?.triggered).toBe(true);
    expect(reloaded?.lastPrice).toBe(90);

    updateWatchPrice(w.id, 120); // rise back above target → re-armed
    reloaded = listWatches().find((x) => x.id === w.id);
    expect(reloaded?.triggered).toBe(false);
    expect(reloaded?.lastPrice).toBe(120);

    updateWatchPrice(w.id, 95); // next genuine drop triggers again
    reloaded = listWatches().find((x) => x.id === w.id);
    expect(reloaded?.triggered).toBe(true);
  });

  it("treats a price exactly at the target as triggered (<=)", () => {
    const w = addWatch("B0EXACT01", "US", 49.99);
    updateWatchPrice(w.id, 49.99);
    const reloaded = listWatches().find((x) => x.id === w.id);
    expect(reloaded?.triggered).toBe(true);
  });
});

describe("addWatch re-arm on duplicate insert", () => {
  it("re-adding the same (asin, marketplace, target) resets triggered without duplicating", () => {
    const original = addWatch("B0READD01", "US", 100);
    updateWatchPrice(original.id, 80); // triggered=1
    expect(listWatches().find((x) => x.id === original.id)?.triggered).toBe(true);

    const readded = addWatch("B0READD01", "US", 100);
    expect(readded.id).toBe(original.id); // same row, not a duplicate
    expect(readded.triggered).toBe(false); // re-armed

    const matching = listWatches().filter(
      (x) => x.asin === "B0READD01" && x.marketplace === "US" && x.targetPrice === 100,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].triggered).toBe(false);
    // Re-arm only resets the trigger; the last observed price is preserved.
    expect(matching[0].lastPrice).toBe(80);
  });

  it("a different target price on the same asin is a separate watch, untouched by re-arm", () => {
    const w50 = addWatch("B0MULTI01", "US", 50);
    const w70 = addWatch("B0MULTI01", "US", 70);
    expect(w70.id).not.toBe(w50.id);

    updateWatchPrice(w70.id, 60); // triggers the 70-target watch only
    addWatch("B0MULTI01", "US", 50); // re-adding the OTHER watch must not touch it

    const reloaded70 = listWatches().find((x) => x.id === w70.id);
    expect(reloaded70?.triggered).toBe(true);
  });
});

describe("logPrice same-day dedup", () => {
  it("skips a repeat of the same price on the same day", () => {
    logPrice("B0DEDUP01", "US", 19.99);
    logPrice("B0DEDUP01", "US", 19.99);

    const log = getPriceLog("B0DEDUP01", "US");
    expect(log).toHaveLength(1);
    expect(log[0].price).toBe(19.99);
  });

  it("a different price DOES add a new point", () => {
    logPrice("B0DEDUP02", "US", 19.99);
    logPrice("B0DEDUP02", "US", 17.5);

    const log = getPriceLog("B0DEDUP02", "US");
    expect(log).toHaveLength(2);
    expect([...log.map((e) => e.price)].sort((a, b) => a - b)).toEqual([17.5, 19.99]);
  });

  it("dedup only compares against the NEWEST row: A → B → A logs 3 points", () => {
    logPrice("B0DEDUP03", "US", 10);
    logPrice("B0DEDUP03", "US", 12);
    logPrice("B0DEDUP03", "US", 10); // latest is 12, so this 10 is NOT a dup

    expect(getPriceLog("B0DEDUP03", "US")).toHaveLength(3);
  });

  it("the same price on a different marketplace is not deduped", () => {
    logPrice("B0DEDUP04", "US", 25);
    logPrice("B0DEDUP04", "ES", 25);

    expect(getPriceLog("B0DEDUP04", "US")).toHaveLength(1);
    expect(getPriceLog("B0DEDUP04", "ES")).toHaveLength(1);
  });
});

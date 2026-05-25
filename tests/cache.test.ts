import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addWatch,
  cacheGet,
  cacheSet,
  closeDb,
  getOrFetch,
  getPriceLog,
  listWatches,
  logPrice,
  removeWatch,
  updateWatchPrice,
} from "../src/lib/cache.js";

let dbPath = "";

beforeEach(() => {
  // Close any DB opened by a previous test BEFORE stubbing the new path, so the
  // next getDb() re-resolves the (freshly stubbed) AMAZON_CACHE_DB_PATH.
  closeDb();
  dbPath = join(tmpdir(), `amztest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

describe("generic cache", () => {
  it("round-trips an object via cacheSet/cacheGet", () => {
    const value = { asin: "B0001", price: 19.99, tags: ["a", "b"] };
    cacheSet("k1", value, 3600);
    expect(cacheGet<typeof value>("k1")).toEqual(value);
  });

  it("returns null for a missing key", () => {
    expect(cacheGet("does-not-exist")).toBeNull();
  });

  it("returns null for an already-expired entry (negative TTL)", () => {
    cacheSet("expired", { a: 1 }, -1);
    expect(cacheGet("expired")).toBeNull();
  });
});

describe("getOrFetch", () => {
  it("calls the fetcher only on a cache miss", async () => {
    const fetcher = vi.fn(async () => ({ v: 42 }));

    const first = await getOrFetch("gof-key", 3600, fetcher);
    expect(first).toEqual({ v: 42 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const second = await getOrFetch("gof-key", 3600, fetcher);
    expect(second).toEqual({ v: 42 });
    // Second call is served from cache — fetcher not invoked again.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("price watches", () => {
  it("addWatch returns a non-triggered watch and listWatches includes it", () => {
    const w = addWatch("B0WATCH01", "US", 50);
    expect(w.asin).toBe("B0WATCH01");
    expect(w.marketplace).toBe("US");
    expect(w.targetPrice).toBe(50);
    expect(w.triggered).toBe(false);
    expect(w.id).toBeGreaterThan(0);

    const all = listWatches();
    expect(all.some((x) => x.id === w.id)).toBe(true);
  });

  it("addWatch is idempotent for the same asin+marketplace+price", () => {
    const a = addWatch("B0DUP01", "US", 25);
    const b = addWatch("B0DUP01", "US", 25);
    expect(b.id).toBe(a.id);
    const matching = listWatches().filter(
      (w) => w.asin === "B0DUP01" && w.marketplace === "US" && w.targetPrice === 25,
    );
    expect(matching).toHaveLength(1);
  });

  it("updateWatchPrice flips triggered=true when price <= target", () => {
    const w = addWatch("B0TRIG01", "US", 30);
    updateWatchPrice(w.id, 28); // below target
    const reloaded = listWatches().find((x) => x.id === w.id);
    expect(reloaded?.triggered).toBe(true);
    expect(reloaded?.lastPrice).toBe(28);
  });

  it("updateWatchPrice above target does NOT trigger", () => {
    const w = addWatch("B0NOTRIG", "US", 30);
    updateWatchPrice(w.id, 45); // above target
    const reloaded = listWatches().find((x) => x.id === w.id);
    expect(reloaded?.triggered).toBe(false);
    expect(reloaded?.lastPrice).toBe(45);
  });

  it("removeWatch returns true for an existing id and false for a missing one", () => {
    const w = addWatch("B0RM01", "US", 10);
    expect(removeWatch(w.id)).toBe(true);
    expect(listWatches().some((x) => x.id === w.id)).toBe(false);
    expect(removeWatch(99999)).toBe(false);
  });
});

describe("price log", () => {
  it("logPrice + getPriceLog returns all logged prices ordered by date desc", () => {
    logPrice("B0LOG01", "US", 10);
    logPrice("B0LOG01", "US", 12);
    logPrice("B0LOG01", "US", 11);

    const log = getPriceLog("B0LOG01", "US");
    expect(log).toHaveLength(3);
    // All logged prices are present (tie-break order is unspecified when the
    // ISO scraped_at timestamps collide within the same millisecond).
    expect([...log.map((e) => e.price)].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    // Dates are non-increasing (descending by scraped_at).
    for (let i = 1; i < log.length; i++) {
      expect(log[i - 1].date >= log[i].date).toBe(true);
    }
    for (const entry of log) {
      expect(typeof entry.date).toBe("string");
      expect(typeof entry.price).toBe("number");
    }
  });

  it("getPriceLog scopes by asin + marketplace", () => {
    logPrice("B0SCOPE", "US", 100);
    logPrice("B0SCOPE", "ES", 200);
    const us = getPriceLog("B0SCOPE", "US");
    expect(us).toHaveLength(1);
    expect(us[0].price).toBe(100);
  });
});

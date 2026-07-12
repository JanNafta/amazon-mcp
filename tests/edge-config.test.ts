import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig, resolveMarketplace } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig — positiveIntEnv hardening (TTLs)", () => {
  it("uses the documented defaults when no env vars are set", () => {
    const cfg = loadConfig();
    expect(cfg.cacheTtlProduct).toBe(3600);
    expect(cfg.cacheTtlPriceHistory).toBe(21600);
    expect(cfg.cacheTtlDeals).toBe(900);
  });

  it('"0" is not a positive int → falls back to the default (3600)', () => {
    vi.stubEnv("AMAZON_CACHE_TTL_PRODUCT", "0");
    expect(loadConfig().cacheTtlProduct).toBe(3600);
  });

  it("negative values fall back to the default", () => {
    vi.stubEnv("AMAZON_CACHE_TTL_PRODUCT", "-5");
    vi.stubEnv("AMAZON_CACHE_TTL_DEALS", "-1");
    const cfg = loadConfig();
    expect(cfg.cacheTtlProduct).toBe(3600);
    expect(cfg.cacheTtlDeals).toBe(900);
  });

  it("non-numeric garbage falls back to the default", () => {
    vi.stubEnv("AMAZON_CACHE_TTL_PRODUCT", "abc");
    vi.stubEnv("AMAZON_CACHE_TTL_PRICE_HISTORY", "NaN");
    const cfg = loadConfig();
    expect(cfg.cacheTtlProduct).toBe(3600);
    expect(cfg.cacheTtlPriceHistory).toBe(21600);
  });

  it("empty string coerces to 0 → falls back to the default", () => {
    vi.stubEnv("AMAZON_CACHE_TTL_PRODUCT", "");
    expect(loadConfig().cacheTtlProduct).toBe(3600);
  });

  it("a valid positive integer is used as-is", () => {
    vi.stubEnv("AMAZON_CACHE_TTL_PRODUCT", "7200");
    expect(loadConfig().cacheTtlProduct).toBe(7200);
  });

  it("floats are floored to an integer", () => {
    vi.stubEnv("AMAZON_CACHE_TTL_PRODUCT", "3600.9");
    expect(loadConfig().cacheTtlProduct).toBe(3600);
  });

  it("a sub-1 positive float falls back to the default, never a 0 TTL (0.9 → 3600)", () => {
    // Floor happens BEFORE the >0 check, so 0.9 → 0 → fails the guard → default.
    // A 0 TTL must never leak through: it would disable the cache entirely.
    vi.stubEnv("AMAZON_CACHE_TTL_PRODUCT", "0.9");
    expect(loadConfig().cacheTtlProduct).toBe(3600);
  });

  it("Infinity is rejected (not finite) → default", () => {
    vi.stubEnv("AMAZON_CACHE_TTL_PRODUCT", "Infinity");
    expect(loadConfig().cacheTtlProduct).toBe(3600);
  });

  it("scientific and hex notations accepted by Number() are honored", () => {
    vi.stubEnv("AMAZON_CACHE_TTL_PRODUCT", "1e3");
    vi.stubEnv("AMAZON_CACHE_TTL_DEALS", "0x10");
    const cfg = loadConfig();
    expect(cfg.cacheTtlProduct).toBe(1000);
    expect(cfg.cacheTtlDeals).toBe(16);
  });

  it("surrounding whitespace is tolerated by Number()", () => {
    vi.stubEnv("AMAZON_CACHE_TTL_PRICE_HISTORY", "  1234  ");
    expect(loadConfig().cacheTtlPriceHistory).toBe(1234);
  });

  it("each TTL var is independent (only the stubbed one changes)", () => {
    vi.stubEnv("AMAZON_CACHE_TTL_DEALS", "60");
    const cfg = loadConfig();
    expect(cfg.cacheTtlDeals).toBe(60);
    expect(cfg.cacheTtlProduct).toBe(3600);
    expect(cfg.cacheTtlPriceHistory).toBe(21600);
  });
});

describe("loadConfig — defaultMarketplace normalization", () => {
  it("lowercase code is uppercased ('es' → 'ES')", () => {
    vi.stubEnv("AMAZON_DEFAULT_MARKETPLACE", "es");
    expect(loadConfig().defaultMarketplace).toBe("ES");
  });

  it("unknown code falls back to 'US'", () => {
    vi.stubEnv("AMAZON_DEFAULT_MARKETPLACE", "ZZ");
    expect(loadConfig().defaultMarketplace).toBe("US");
  });

  it("empty string falls back to 'US'", () => {
    vi.stubEnv("AMAZON_DEFAULT_MARKETPLACE", "");
    expect(loadConfig().defaultMarketplace).toBe("US");
  });

  it("mixed-case valid code is normalized ('uK' → 'UK')", () => {
    vi.stubEnv("AMAZON_DEFAULT_MARKETPLACE", "uK");
    expect(loadConfig().defaultMarketplace).toBe("UK");
  });
});

describe("loadConfig — cacheDbPath passthrough", () => {
  it("defaults to empty string when unset", () => {
    vi.stubEnv("AMAZON_CACHE_DB_PATH", "");
    expect(loadConfig().cacheDbPath).toBe("");
  });

  it("passes an explicit path through untouched", () => {
    vi.stubEnv("AMAZON_CACHE_DB_PATH", "/tmp/some/dir/cache.db");
    expect(loadConfig().cacheDbPath).toBe("/tmp/some/dir/cache.db");
  });
});

describe("resolveMarketplace — hardened fallback paths (not covered in config.test.ts)", () => {
  it("lowercase 'uk' resolves to www.amazon.co.uk with full metadata", () => {
    const mp = resolveMarketplace("uk");
    expect(mp.host).toBe("www.amazon.co.uk");
    expect(mp.code).toBe("UK");
    expect(mp.currency).toBe("GBP");
    expect(mp.tld).toBe("co.uk");
  });

  it("an explicit code wins over AMAZON_DEFAULT_MARKETPLACE", () => {
    vi.stubEnv("AMAZON_DEFAULT_MARKETPLACE", "DE");
    expect(resolveMarketplace("jp").host).toBe("www.amazon.co.jp");
  });

  it("invalid env default + no code → US", () => {
    vi.stubEnv("AMAZON_DEFAULT_MARKETPLACE", "narnia");
    const mp = resolveMarketplace(undefined);
    expect(mp.code).toBe("US");
    expect(mp.host).toBe("www.amazon.com");
  });

  it("lowercase env default is uppercased before lookup ('fr' → amazon.fr)", () => {
    vi.stubEnv("AMAZON_DEFAULT_MARKETPLACE", "fr");
    expect(resolveMarketplace(undefined).host).toBe("www.amazon.fr");
  });

  it("empty-string code behaves like undefined (falls back to env default)", () => {
    vi.stubEnv("AMAZON_DEFAULT_MARKETPLACE", "IT");
    expect(resolveMarketplace("").host).toBe("www.amazon.it");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { MARKETPLACES, resolveMarketplace } from "../src/config.js";
import type { MarketplaceCode } from "../src/types.js";

describe("resolveMarketplace", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves an explicit code (ES)", () => {
    expect(resolveMarketplace("ES").host).toBe("www.amazon.es");
  });

  it("is case-insensitive for the code", () => {
    expect(resolveMarketplace("es").host).toBe("www.amazon.es");
  });

  it("falls back to the AMAZON_DEFAULT_MARKETPLACE env when code is undefined", () => {
    vi.stubEnv("AMAZON_DEFAULT_MARKETPLACE", "DE");
    expect(resolveMarketplace(undefined).host).toBe("www.amazon.de");
  });

  it("falls back to US for an unknown code", () => {
    expect(resolveMarketplace("ZZ").host).toBe("www.amazon.com");
    expect(resolveMarketplace("ZZ").code).toBe("US");
  });
});

describe("MARKETPLACES", () => {
  const expectedCodes: MarketplaceCode[] = [
    "US",
    "ES",
    "UK",
    "DE",
    "FR",
    "IT",
    "CA",
    "JP",
    "MX",
    "IN",
    "BR",
    "AU",
  ];

  it("contains exactly 12 marketplaces", () => {
    expect(Object.keys(MARKETPLACES)).toHaveLength(12);
  });

  it("has all expected marketplace codes", () => {
    for (const code of expectedCodes) {
      expect(MARKETPLACES[code]).toBeDefined();
    }
  });

  it("each marketplace has complete fields", () => {
    for (const code of expectedCodes) {
      const mp = MARKETPLACES[code];
      expect(mp.code).toBe(code);
      expect(typeof mp.tld).toBe("string");
      expect(mp.tld.length).toBeGreaterThan(0);
      expect(mp.host).toMatch(/^www\.amazon\./);
      expect(typeof mp.acceptLanguage).toBe("string");
      expect(mp.acceptLanguage.length).toBeGreaterThan(0);
      expect(typeof mp.currency).toBe("string");
      expect(mp.currency.length).toBe(3);
      expect(typeof mp.tagSuffix).toBe("string");
      expect(mp.tagSuffix.length).toBeGreaterThan(0);
    }
  });
});

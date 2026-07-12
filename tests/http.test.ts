import { describe, expect, it } from "vitest";

import { extractAsin, parsePrice } from "../src/lib/http.js";

describe("parsePrice", () => {
  it("parses US formatted price '$1,234.56'", () => {
    expect(parsePrice("$1,234.56")).toBe(1234.56);
  });

  it("parses EU formatted price '1.234,56 €'", () => {
    expect(parsePrice("1.234,56 €")).toBe(1234.56);
  });

  it("parses '£12.99'", () => {
    expect(parsePrice("£12.99")).toBe(12.99);
  });

  it("parses '12,99' as decimal comma", () => {
    expect(parsePrice("12,99")).toBe(12.99);
  });

  it("treats a lone comma before 3 digits as a thousands group: '1,299' -> 1299", () => {
    // A separator followed by exactly 3 digits is a thousands group (Amazon never
    // renders a bare 3-decimal price), so "1,299" is 1299 — not 1.299.
    expect(parsePrice("1,299")).toBe(1299);
  });

  it("treats a comma before 2 digits as a decimal separator: '12,99' -> 12.99", () => {
    expect(parsePrice("12,99")).toBe(12.99);
  });

  it("parses grouped JPY/USD integers with no decimals: '￥4,988' -> 4988, '$1,234' -> 1234", () => {
    expect(parsePrice("￥4,988")).toBe(4988);
    expect(parsePrice("$1,234")).toBe(1234);
  });

  it("parses the Indian lakh grouping: '₹1,29,900' -> 129900", () => {
    expect(parsePrice("₹1,29,900")).toBe(129900);
  });

  it("returns only the first price of a range: '10,99 € - 24,99 €' -> 10.99", () => {
    expect(parsePrice("10,99 € - 24,99 €")).toBe(10.99);
  });

  it("returns null for empty string", () => {
    expect(parsePrice("")).toBeNull();
  });

  it("returns null for null", () => {
    expect(parsePrice(null)).toBeNull();
  });

  it("returns null for non-numeric text", () => {
    expect(parsePrice("Currently unavailable")).toBeNull();
  });
});

describe("extractAsin", () => {
  it("extracts ASIN from a /dp/ URL", () => {
    expect(extractAsin("https://www.amazon.com/dp/B08N5WRWNW")).toBe("B08N5WRWNW");
  });

  it("extracts ASIN from a /gp/product/ URL with ref suffix", () => {
    expect(extractAsin("/gp/product/B07XYZ1234/ref=foo_bar")).toBe("B07XYZ1234");
  });

  it("normalizes a lowercase ASIN in a URL path to uppercase", () => {
    // The URL-path regex is case-insensitive, so lowercase ASINs in a /dp/ path
    // are matched and upper-cased.
    expect(extractAsin("https://www.amazon.com/dp/b08n5wrwnw")).toBe("B08N5WRWNW");
  });

  it("matches a bare uppercase 10-char ASIN", () => {
    expect(extractAsin("B08N5WRWNW")).toBe("B08N5WRWNW");
  });

  it("matches a bare lowercase ASIN and normalizes it to uppercase", () => {
    // The bare-string fallback regex is case-insensitive, so lowercase bare
    // ASINs are matched and upper-cased.
    expect(extractAsin("b08n5wrwnw")).toBe("B08N5WRWNW");
  });

  it("returns null for a string without an ASIN", () => {
    expect(extractAsin("just some text")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(extractAsin(null)).toBeNull();
    expect(extractAsin(undefined)).toBeNull();
  });
});

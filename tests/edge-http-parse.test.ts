import { describe, expect, it } from "vitest";

import { extractAsin, parsePrice } from "../src/lib/http.js";

describe("parsePrice — hardened separator heuristics", () => {
  describe("lone separator + exactly 3 trailing digits = thousands group", () => {
    it("'$1,234' -> 1234 (US grouped integer, no decimals)", () => {
      expect(parsePrice("$1,234")).toBe(1234);
    });

    it("'1.234 €' -> 1234 (EU dot-grouped integer)", () => {
      expect(parsePrice("1.234 €")).toBe(1234);
    });

    it("'￥4,988' -> 4988 (JPY has no decimals)", () => {
      expect(parsePrice("￥4,988")).toBe(4988);
    });

    it("'1,299' and '2,980' are thousands, not 3-decimal prices", () => {
      expect(parsePrice("1,299")).toBe(1299);
      expect(parsePrice("2,980")).toBe(2980);
    });
  });

  describe("lone separator + 1-2 trailing digits = decimal separator", () => {
    it("'12,99' -> 12.99 (EU decimal comma)", () => {
      expect(parsePrice("12,99")).toBe(12.99);
    });

    it("'£12.99' -> 12.99", () => {
      expect(parsePrice("£12.99")).toBe(12.99);
    });

    it("'1,2' -> 1.2 (single trailing digit)", () => {
      expect(parsePrice("1,2")).toBe(1.2);
    });

    it("'0,50' -> 0.5 (leading zero preserved as integer part)", () => {
      expect(parsePrice("0,50")).toBe(0.5);
    });

    it("'1.00' -> 1 (two trailing zeros collapse)", () => {
      expect(parsePrice("1.00")).toBe(1);
    });
  });

  describe("both separators present = last one is the decimal point", () => {
    it("'$1,234.56' -> 1234.56 (US)", () => {
      expect(parsePrice("$1,234.56")).toBe(1234.56);
    });

    it("'1.234,56 €' -> 1234.56 (EU)", () => {
      expect(parsePrice("1.234,56 €")).toBe(1234.56);
    });

    it("'1.234.567,89' -> 1234567.89 (multi-group EU)", () => {
      expect(parsePrice("1.234.567,89")).toBe(1234567.89);
    });

    it("both-separator rule overrides the 3-digit rule: '1,234.567' -> 1234.567", () => {
      // With both separator kinds present, the LAST one is always decimal even
      // when followed by 3 digits (the other kind proves it's not grouping).
      expect(parsePrice("1,234.567")).toBe(1234.567);
    });
  });

  describe("Indian lakh grouping (irregular group sizes, comma only)", () => {
    it("'₹1,29,900' -> 129900", () => {
      expect(parsePrice("₹1,29,900")).toBe(129900);
    });

    it("'₹1,23,456' -> 123456", () => {
      expect(parsePrice("₹1,23,456")).toBe(123456);
    });
  });

  describe("price ranges return the FIRST price", () => {
    it("'10,99 € - 24,99 €' -> 10.99", () => {
      expect(parsePrice("10,99 € - 24,99 €")).toBe(10.99);
    });

    it("'$10.99 - $24.99' -> 10.99", () => {
      expect(parsePrice("$10.99 - $24.99")).toBe(10.99);
    });

    it("'₹1,29,900 - ₹1,49,900' -> 129900 (lakh range)", () => {
      expect(parsePrice("₹1,29,900 - ₹1,49,900")).toBe(129900);
    });
  });

  describe("12-marketplace currency matrix", () => {
    it("parses every marketplace's native rendering", () => {
      expect(parsePrice("$29.99")).toBe(29.99); // US
      expect(parsePrice("£249.00")).toBe(249); // UK
      expect(parsePrice("1.099,00 €")).toBe(1099); // DE
      expect(parsePrice("1 299,00 €")).toBe(1299); // FR (narrow NBSP grouping)
      expect(parsePrice("2.499,90 €")).toBe(2499.9); // IT
      expect(parsePrice("24,99 €")).toBe(24.99); // ES
      expect(parsePrice("￥12,980")).toBe(12980); // JP (no decimals)
      expect(parsePrice("₹64,900")).toBe(64900); // IN (thousands, not decimal)
      expect(parsePrice("CDN$ 1,234.99")).toBe(1234.99); // CA
      expect(parsePrice("MX$1,299.00")).toBe(1299); // MX
      expect(parsePrice("R$ 1.234,56")).toBe(1234.56); // BR
      expect(parsePrice("AU$39.95")).toBe(39.95); // AU
    });
  });

  describe("whitespace, NBSP, emojis and boundary values", () => {
    it("regular-space and NBSP (\\u00a0) grouping both parse: '1 234,56 €' / '1\\u00a0234,56 €' -> 1234.56", () => {
      expect(parsePrice("1 234,56 €")).toBe(1234.56);
      expect(parsePrice("1 234,56 €")).toBe(1234.56);
    });

    it("ignores surrounding emoji/noise: '🔥 Deal: $9.99 only!' -> 9.99", () => {
      expect(parsePrice("🔥 Deal: $9.99 only!")).toBe(9.99);
    });

    it("very large price: '$123,456,789.99' -> 123456789.99", () => {
      expect(parsePrice("$123,456,789.99")).toBe(123456789.99);
    });

    it("a single bare digit parses: '5' -> 5", () => {
      expect(parsePrice("5")).toBe(5);
    });

    it("minus signs are stripped (prices are magnitudes): '-$5.00' -> 5", () => {
      // The tokenizer only captures the digit run, so a leading minus never
      // produces a negative number.
      expect(parsePrice("-$5.00")).toBe(5);
    });
  });

  describe("null returns", () => {
    it("returns null for '', null, undefined", () => {
      expect(parsePrice("")).toBeNull();
      expect(parsePrice(null)).toBeNull();
      expect(parsePrice(undefined)).toBeNull();
    });

    it("returns null for digit-free text: 'Currently unavailable'", () => {
      expect(parsePrice("Currently unavailable")).toBeNull();
      expect(parsePrice("$ —")).toBeNull();
    });

    it("keeps a leading decimal separator (no leading zero): '$.99' → 0.99", () => {
      // Regression: the number token must not drop a decimal point that starts the run.
      expect(parsePrice("$.99")).toBe(0.99);
      expect(parsePrice(".99")).toBe(0.99);
      expect(parsePrice(",99 €")).toBe(0.99);
    });

    it("does not merge two whitespace-separated prices: '9.99 14.99' → 9.99", () => {
      // Regression: whitespace only joins a run as a thousands separator (before a
      // 3-digit group), so two distinct prices separated by a space don't fuse.
      expect(parsePrice("9.99 14.99")).toBe(9.99);
      expect(parsePrice("10,99\n24,99")).toBe(10.99);
    });
  });
});

describe("extractAsin — URL paths, bare strings and null cases", () => {
  it("extracts from /dp/ URL with query string", () => {
    expect(extractAsin("https://www.amazon.com/dp/B08N5WRWNW?th=1&psc=1")).toBe("B08N5WRWNW");
  });

  it("extracts from /gp/product/ with ref suffix", () => {
    expect(extractAsin("/gp/product/B07XYZ1234/ref=ppx_yo_dt_b")).toBe("B07XYZ1234");
  });

  it("extracts from the mobile /gp/aw/d/ path", () => {
    expect(extractAsin("https://www.amazon.co.jp/gp/aw/d/B0ABCDEFGH")).toBe("B0ABCDEFGH");
  });

  it("extracts from a bare /product/ path", () => {
    expect(extractAsin("https://www.amazon.de/product/B09QWERTY0")).toBe("B09QWERTY0");
  });

  it("uppercases a lowercase ASIN in a /dp/ path", () => {
    expect(extractAsin("https://www.amazon.com/dp/b08n5wrwnw")).toBe("B08N5WRWNW");
  });

  it("matches a bare 10-char ASIN and uppercases lowercase input", () => {
    expect(extractAsin("B08N5WRWNW")).toBe("B08N5WRWNW");
    expect(extractAsin("b08n5wrwnw")).toBe("B08N5WRWNW");
  });

  it("falls back to a 10-char token inside a query string", () => {
    expect(extractAsin("https://www.amazon.com/exec/obidos?asin=B0C1234567&tag=x")).toBe("B0C1234567");
  });

  it("path match wins over other 10-char words in the string", () => {
    // "erasers123" would match the bare fallback, but the /dp/ path regex
    // runs first and takes precedence.
    expect(extractAsin("erasers123 https://amazon.com/dp/B0AAAAAAAA")).toBe("B0AAAAAAAA");
  });

  it("returns null when the only candidate is too short or too long", () => {
    expect(extractAsin("/dp/B08N5WRW")).toBeNull(); // 8 chars in path, no bare 10-char run
    expect(extractAsin("B08N5WRWNW1")).toBeNull(); // 11-char run has no word boundary split
  });

  it("returns null for text without any 10-char alphanumeric word", () => {
    expect(extractAsin("just some text")).toBeNull();
  });

  it("returns null for '', null, undefined", () => {
    expect(extractAsin("")).toBeNull();
    expect(extractAsin(null)).toBeNull();
    expect(extractAsin(undefined)).toBeNull();
  });
});

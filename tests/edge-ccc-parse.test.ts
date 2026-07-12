import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock ONLY fetchHtml (network); keep the real parsePrice so the price-cell
// classification is exercised against the real parser.
vi.mock("../src/lib/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/http.js")>();
  return { ...actual, fetchHtml: vi.fn() };
});

import { getPriceHistory } from "../src/lib/camelcamelcamel.js";
import { fetchHtml } from "../src/lib/http.js";
import type { MarketplaceCode } from "../src/types.js";

const fetchHtmlMock = vi.mocked(fetchHtml);

/** Build a CCC-style price table page from label/cell rows. */
function cccPage(rows: string[][]): string {
  const trs = rows
    .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("\n");
  return `<html><body><div class="content"><table class="product_pane">${trs}</table></div></body></html>`;
}

beforeEach(() => {
  fetchHtmlMock.mockReset();
});

describe("getPriceHistory — degraded contract for marketplaces without a CCC host (no network)", () => {
  const unsupported: Array<[MarketplaceCode, string]> = [
    ["MX", "MXN"],
    ["IN", "INR"],
    ["BR", "BRL"],
    ["AU", "AUD"],
  ];

  it.each(unsupported)(
    "%s resolves to a null-filled PriceHistory without touching the network",
    async (code, currency) => {
      const result = await getPriceHistory("B08N5WRWNW", code);

      expect(fetchHtmlMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        asin: "B08N5WRWNW",
        marketplace: code,
        currency,
        current: null,
        lowest: null,
        lowestDate: null,
        highest: null,
        highestDate: null,
        average: null,
        dropFromHighPct: null,
        verdict: "Price history not available for this marketplace",
        source: "camelcamelcamel",
        chartUrl: null,
      });
    },
  );
});

describe("getPriceHistory — host/country mapping", () => {
  it("CA fetches ca.camelcamelcamel.com and builds a /ca/ chart URL (not /us/)", async () => {
    fetchHtmlMock.mockResolvedValueOnce(cccPage([["Amazon", "CDN$ 24.99"]]));

    const result = await getPriceHistory("B0TESTCA01", "CA");

    expect(fetchHtmlMock).toHaveBeenCalledTimes(1);
    expect(fetchHtmlMock).toHaveBeenCalledWith(
      "https://ca.camelcamelcamel.com/product/B0TESTCA01",
      { acceptLanguage: "en-US,en;q=0.9", retries: 2 },
    );
    expect(result.chartUrl).toContain("https://charts.camelcamelcamel.com/ca/B0TESTCA01/amazon.png");
    expect(result.chartUrl).not.toContain("/us/");
    expect(result.currency).toBe("CAD");
    expect(result.current).toBe(24.99);
  });

  it("US fetches the bare camelcamelcamel.com host with a /us/ chart URL", async () => {
    fetchHtmlMock.mockResolvedValueOnce(cccPage([["Amazon", "$10.00"]]));

    const result = await getPriceHistory("B0TESTUS01", "US");

    expect(fetchHtmlMock).toHaveBeenCalledWith(
      "https://camelcamelcamel.com/product/B0TESTUS01",
      expect.objectContaining({ retries: 2 }),
    );
    expect(result.chartUrl).toContain("/us/B0TESTUS01/amazon.png");
  });
});

describe("getPriceHistory — never throws, always a well-formed PriceHistory", () => {
  it("degrades when fetchHtml rejects (Cloudflare) with a null chartUrl", async () => {
    fetchHtmlMock.mockRejectedValueOnce(new Error("403 challenge"));

    const result = await getPriceHistory("B08N5WRWNW", "UK");

    expect(result.marketplace).toBe("UK");
    expect(result.currency).toBe("GBP");
    expect(result.current).toBeNull();
    expect(result.lowest).toBeNull();
    expect(result.highest).toBeNull();
    expect(result.average).toBeNull();
    expect(result.dropFromHighPct).toBeNull();
    expect(result.chartUrl).toBeNull();
    expect(result.verdict).toBe(
      "CamelCamelCamel unavailable (Cloudflare-protected) — using local price history",
    );
    expect(result.source).toBe("camelcamelcamel");
  });

  it("a page with no price table yields nulls, 'Current price unknown', but keeps the chartUrl", async () => {
    fetchHtmlMock.mockResolvedValueOnce("<html><body><h1>Just a heading, no table</h1></body></html>");

    const result = await getPriceHistory("B0EMPTY001", "DE");

    expect(result.current).toBeNull();
    expect(result.lowest).toBeNull();
    expect(result.verdict).toBe("Current price unknown");
    // Fetch succeeded, so the chart CDN URL is still useful and preserved.
    expect(result.chartUrl).toContain("/de/B0EMPTY001/amazon.png");
  });
});

describe("getPriceHistory — price-table parsing edge cases", () => {
  it("parses a full CCC table: current/lowest/highest/average, ISO dates, drop-from-high", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      cccPage([
        ["Amazon", "$80.00"],
        ["Lowest Price", "$60.00", "2024-12-24"],
        ["Highest Price", "$120.00", "2023-01-05"],
        ["Average Price", "$95.50"],
      ]),
    );

    const result = await getPriceHistory("B0FULLTBL1", "US");

    expect(result.current).toBe(80);
    expect(result.lowest).toBe(60);
    expect(result.highest).toBe(120);
    expect(result.average).toBe(95.5);
    // ISO input dates are parsed as UTC, so normalization is timezone-stable.
    expect(result.lowestDate).toBe("2024-12-24");
    expect(result.highestDate).toBe("2023-01-05");
    // (1 - 80/120) * 100 = 33.33... -> rounded to one decimal.
    expect(result.dropFromHighPct).toBe(33.3);
    // 80 < 95.50 * 0.9 -> below-average branch.
    expect(result.verdict).toBe("Below average — good deal");
  });

  it("normalizes 'Dec 24, 2024'-style dates to ISO yyyy-mm-dd", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      cccPage([
        ["Amazon", "$50.00"],
        ["Lowest Price", "$40.00", "Dec 24, 2024"],
      ]),
    );

    const result = await getPriceHistory("B0DATENORM", "US");

    // new Date("Dec 24, 2024") is local-midnight, so the ISO date can be the
    // 23rd or 24th depending on the runner's timezone; only the format and
    // month are timezone-stable.
    expect(result.lowestDate).toMatch(/^2024-12-2[34]$/);
  });

  it("skips a '3rd Party' seller cell when locating price and date cells", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      cccPage([
        ["Amazon", "$25.00"],
        ["Lowest Price", "3rd Party", "$9.87", "2022-07-01"],
      ]),
    );

    const result = await getPriceHistory("B03RDPARTY", "US");

    expect(result.lowest).toBe(9.87);
    expect(result.lowestDate).toBe("2022-07-01");
  });

  it("only the FIRST 'Amazon'/current row sets the current price", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      cccPage([
        ["Amazon", "$20.00"],
        ["Amazon (used)", "$5.00"],
        ["Current Price", "$1.00"],
      ]),
    );

    const result = await getPriceHistory("B0FIRSTROW", "US");

    expect(result.current).toBe(20);
  });

  it("a bare grouped number without currency or cents ('1,299') is NOT classified as a price", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      cccPage([
        ["Amazon", "$15.00"],
        ["Average Price", "1,299"],
      ]),
    );

    const result = await getPriceHistory("B0BARENUM1", "US");

    // '1,299' has no currency symbol and no 2-decimal cents -> not a price cell.
    expect(result.average).toBeNull();
  });

  it("EU-formatted prices ('1.234,56 €') parse via the decimal-comma path", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      cccPage([
        ["Amazon", "1.234,56 €"],
        ["Lowest Price", "999,99 €", "2024-03-15"],
      ]),
    );

    const result = await getPriceHistory("B0EUFORMAT", "ES");

    expect(result.currency).toBe("EUR");
    expect(result.current).toBe(1234.56);
    expect(result.lowest).toBe(999.99);
  });

  it("a highest price of $0.00 yields a null dropFromHighPct (no divide-by-zero)", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      cccPage([
        ["Amazon", "$10.00"],
        ["Highest Price", "$0.00", "2020-01-01"],
      ]),
    );

    const result = await getPriceHistory("B0ZEROHIGH", "US");

    expect(result.highest).toBe(0);
    expect(result.dropFromHighPct).toBeNull();
  });
});

describe("getPriceHistory — verdict branches", () => {
  async function verdictFor(rows: string[][]): Promise<string> {
    fetchHtmlMock.mockResolvedValueOnce(cccPage(rows));
    const result = await getPriceHistory("B0VERDICT1", "US");
    return result.verdict;
  }

  it("current at (or within 1% of) the all-time low -> lowest-ever verdict", async () => {
    expect(
      await verdictFor([
        ["Amazon", "$60.50"],
        ["Lowest Price", "$60.00", "2024-01-01"],
        ["Average Price", "$100.00"],
      ]),
    ).toBe("At or near the lowest price ever — great time to buy");
  });

  it("current more than 10% below average -> good deal", async () => {
    expect(
      await verdictFor([
        ["Amazon", "$80.00"],
        ["Lowest Price", "$50.00", "2024-01-01"],
        ["Average Price", "$100.00"],
      ]),
    ).toBe("Below average — good deal");
  });

  it("current more than 10% above average -> consider waiting", async () => {
    expect(
      await verdictFor([
        ["Amazon", "$120.00"],
        ["Lowest Price", "$50.00", "2024-01-01"],
        ["Average Price", "$100.00"],
      ]),
    ).toBe("Above average — consider waiting");
  });

  it("current exactly at the average -> around-average verdict", async () => {
    expect(
      await verdictFor([
        ["Amazon", "$100.00"],
        ["Lowest Price", "$50.00", "2024-01-01"],
        ["Average Price", "$100.00"],
      ]),
    ).toBe("Around the average price");
  });

  it("no parsable current price -> 'Current price unknown' even with other rows present", async () => {
    expect(
      await verdictFor([
        ["Amazon", "Currently unavailable"],
        ["Lowest Price", "$50.00", "2024-01-01"],
        ["Average Price", "$100.00"],
      ]),
    ).toBe("Current price unknown");
  });
});

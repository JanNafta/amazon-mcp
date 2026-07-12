import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the http module: keep the real pure helpers (parsePrice, extractAsin),
// only replace the network-bound fetchHtml — same pattern as tests/scraper.test.ts.
vi.mock("../src/lib/http.js", async (orig) => {
  const actual = await orig<typeof import("../src/lib/http.js")>();
  return { ...actual, fetchHtml: vi.fn() };
});

import { fetchHtml } from "../src/lib/http.js";
import { getProductDetails, searchProducts } from "../src/lib/amazon-scraper.js";

/**
 * parseRating / parseCount are internal to amazon-scraper.ts (not exported), so we
 * exercise them INDIRECTLY: synthetic Amazon search/detail HTML is fed through the
 * mocked fetchHtml and the parsed rating/reviewCount/price are asserted on the
 * public searchProducts / getProductDetails results.
 */

function searchCard(asin: string, inner: string): string {
  return `<div data-component-type="s-search-result" data-asin="${asin}">${inner}</div>`;
}

function searchPage(...cards: string[]): string {
  return `<!DOCTYPE html><html><body><div class="s-main-slot">${cards.join("\n")}</div></body></html>`;
}

/** Minimal valid card: title is mandatory for a card to be emitted. */
function titledCard(asin: string, extra = ""): string {
  return searchCard(asin, `<h2><a href="/dp/${asin}"><span>Product ${asin}</span></a></h2>${extra}`);
}

function detailPage(inner: string): string {
  return `<!DOCTYPE html><html><body>${inner}</body></html>`;
}

beforeEach(() => {
  vi.mocked(fetchHtml).mockReset();
});

describe("rating parsing (indirect, via search result cards)", () => {
  it("parses Japanese 'max-before-score' format: 5つ星のうち4.3 → 4.3", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      searchPage(titledCard("B0JPRATING", `<i class="a-icon-star-small" aria-label="5つ星のうち4.3"></i>`)),
    );
    const [p] = await searchProducts("q", "JP");
    expect(p.rating).toBe(4.3);
  });

  it("parses German comma-decimal format: 4,5 von 5 Sternen → 4.5", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      searchPage(titledCard("B0DERATING", `<i class="a-icon-star-small" aria-label="4,5 von 5 Sternen"></i>`)),
    );
    const [p] = await searchProducts("q", "DE");
    expect(p.rating).toBe(4.5);
  });

  it("parses the English rating from the .a-icon-alt text fallback (no aria-label)", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      searchPage(
        titledCard(
          "B0ENRATING",
          `<i class="a-icon-star-small"><span class="a-icon-alt">4.7 out of 5 stars</span></i>`,
        ),
      ),
    );
    const [p] = await searchProducts("q", "US");
    expect(p.rating).toBe(4.7);
  });

  it("falls back to a bare integer rating: '4 out of 5 stars' → 4", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      searchPage(titledCard("B0INTRATIN", `<i class="a-icon-star" aria-label="4 out of 5 stars"></i>`)),
    );
    const [p] = await searchProducts("q", "US");
    expect(p.rating).toBe(4);
  });

  it("rejects out-of-range ratings (>5) instead of reporting garbage", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      searchPage(titledCard("B0BADRATIN", `<i class="a-icon-star" aria-label="9.9 out of 5 stars"></i>`)),
    );
    const [p] = await searchProducts("q", "US");
    expect(p.rating).toBeNull();
  });

  it("takes the rating, not the review count, from a combined aria-label: '4 out of 5 stars, 1,234 ratings' → 4", async () => {
    // Regression: an integer rating followed by a grouped count must not read the
    // count's decimal-looking grouping ("1,234") as the rating (★1.234).
    vi.mocked(fetchHtml).mockResolvedValue(
      searchPage(titledCard("B0CMBRATIN", `<i class="a-icon-star" aria-label="4 out of 5 stars, 1,234 ratings"></i>`)),
    );
    const [p] = await searchProducts("q", "US");
    expect(p.rating).toBe(4);
  });

  it("returns null rating when the card has no rating markup at all", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(searchPage(titledCard("B0NORATING")));
    const [p] = await searchProducts("q", "US");
    expect(p.rating).toBeNull();
  });
});

describe("review count parsing (indirect, via search result cards)", () => {
  async function countFor(countMarkup: string, code: "US" | "DE" | "BR" | "JP" = "US") {
    vi.mocked(fetchHtml).mockResolvedValue(searchPage(titledCard("B0COUNT001", countMarkup)));
    const [p] = await searchProducts("q", code);
    return p.reviewCount;
  }

  it("strips comma grouping: '1,234' → 1234", async () => {
    expect(await countFor(`<span class="a-size-base s-underline-text">1,234</span>`)).toBe(1234);
  });

  it("strips dot grouping and parens (DE style): '(2.399)' → 2399", async () => {
    expect(await countFor(`<span class="a-size-base s-underline-text">(2.399)</span>`, "DE")).toBe(2399);
  });

  it("expands the K abbreviation: '1.2K' → 1200", async () => {
    expect(await countFor(`<span class="a-size-base s-underline-text">1.2K</span>`)).toBe(1200);
  });

  it("expands the Brazilian 'mil' abbreviation with comma decimal: '1,2 mil' → 1200", async () => {
    expect(await countFor(`<span class="a-size-base s-underline-text">1,2 mil</span>`, "BR")).toBe(1200);
  });

  it("expands the M abbreviation: '3M' → 3,000,000", async () => {
    expect(await countFor(`<span class="a-size-base s-underline-text">3M</span>`)).toBe(3_000_000);
  });

  it("expands the Polish 'tys.' abbreviation: '2 tys.' → 2000", async () => {
    expect(await countFor(`<span class="a-size-base s-underline-text">2 tys.</span>`)).toBe(2000);
  });

  it("handles NBSP thousands grouping: '12 345' → 12345", async () => {
    expect(await countFor(`<span class="a-size-base s-underline-text">12 345</span>`)).toBe(12345);
  });

  it("expands the Japanese 万 abbreviation: '(1.6万)' → 16000 (live-confirmed amazon.co.jp format)", async () => {
    // Regression: this used to strip the dot and return 16 — a silent ~1000x
    // corruption for every popular JP product (visible count is rendered as N.N万).
    expect(await countFor(`<span class="a-size-base s-underline-text">(1.6万)</span>`, "JP")).toBe(16000);
    expect(await countFor(`<span class="a-size-base s-underline-text">(1.2万)</span>`, "JP")).toBe(12000);
  });

  it("expands the Japanese 千 abbreviation: '3千' → 3000", async () => {
    expect(await countFor(`<span class="a-size-base s-underline-text">3千</span>`, "JP")).toBe(3000);
  });

  it("expands the German Mio. abbreviation: '1,2 Mio.' → 1200000", async () => {
    expect(await countFor(`<span class="a-size-base s-underline-text">1,2 Mio.</span>`, "DE")).toBe(1_200_000);
  });

  it("returns null (not a fabricated count) for a rating-only aria-label", async () => {
    // Regression: when the underline span is missing, the fallback selector can catch
    // the star-popover anchor ("4.2 out of 5 stars, rating details") — that must not
    // fabricate reviewCount=5 from the "out of 5".
    expect(
      await countFor(`<a href="#customerReviews" aria-label="4.2 out of 5 stars, rating details"></a>`),
    ).toBeNull();
  });

  it("returns null for a Japanese rating-only aria-label: '5つ星のうち4.2'", async () => {
    expect(await countFor(`<a href="#customerReviews" aria-label="5つ星のうち4.2"></a>`, "JP")).toBeNull();
  });

  it("takes the count even when it comes BEFORE the rating: '1,234 ratings, 4.2 stars' → 1234", async () => {
    expect(
      await countFor(`<a href="#customerReviews" aria-label="1,234 ratings, 4.2 stars"></a>`),
    ).toBe(1234);
  });

  it("reads the count from the aria-label anchor fallback when no underline text exists", async () => {
    expect(await countFor(`<a href="#customerReviews" aria-label="1,234 ratings"></a>`)).toBe(1234);
  });

  it("takes the count (last number), not the rating, from a combined aria-label: '4.2 out of 5 stars, 1,234 ratings' → 1234", async () => {
    // Regression: parseCount must not take the leading rating ("4.2" → 42) nor
    // concatenate every digit ("4251234") from a combined rating+count aria-label.
    expect(
      await countFor(`<a href="#customerReviews" aria-label="4.2 out of 5 stars, 1,234 ratings"></a>`),
    ).toBe(1234);
  });

  it("returns null reviewCount when the card has no count markup", async () => {
    expect(await countFor("")).toBeNull();
  });
});

describe("getProductDetails — zero-decimal currencies and locale parsing", () => {
  it("parses a JPY buybox price without inventing decimals: ￥3,980 → 3980 JPY", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      detailPage(`
        <span id="productTitle"> ソニー ワイヤレスイヤホン </span>
        <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">￥3,980</span></span></div>
        <span id="acrPopover" title="5つ星のうち4.3"></span>
        <span id="acrCustomerReviewText">1,234個の評価</span>
      `),
    );
    const d = await getProductDetails("B0JPYPRICE", "JP");
    expect(d.price).toBe(3980);
    expect(d.currency).toBe("JPY");
    expect(d.rating).toBe(4.3);
    expect(d.reviewCount).toBe(1234);
    expect(d.title).toBe("ソニー ワイヤレスイヤホン");
  });

  it("parses INR lakh grouping: ₹1,29,900 → 129900 INR", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      detailPage(`
        <span id="productTitle">Apple iPhone</span>
        <div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">₹1,29,900.00</span></span></div>
      `),
    );
    const d = await getProductDetails("B0INRPRICE", "IN");
    expect(d.price).toBe(129900);
    expect(d.currency).toBe("INR");
  });

  it("recovers a split-node price (.a-price-whole + .a-price-fraction) when .a-offscreen is empty", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      detailPage(`
        <span id="productTitle">Split Price Product</span>
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price"><span class="a-offscreen"></span></span>
          <span class="a-price-whole">1,299</span><span class="a-price-fraction">99</span>
        </div>
      `),
    );
    const d = await getProductDetails("B0SPLITPRC", "US");
    expect(d.price).toBe(1299.99);
  });
});

describe("hardened failure modes and sanitization", () => {
  it("searchProducts throws (not []) when the page has no result cards", async () => {
    vi.mocked(fetchHtml).mockResolvedValue("<html><body><p>Robot check</p></body></html>");
    await expect(searchProducts("q", "US")).rejects.toThrow(/no result cards found/);
  });

  it("searchProducts throws when cards exist but none parse (missing titles)", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      searchPage(searchCard("B0NOTITLE1", `<span class="a-price"><span class="a-offscreen">$9.99</span></span>`)),
    );
    await expect(searchProducts("q", "US")).rejects.toThrow(/result cards present but none parsed/);
  });

  it("deduplicates cards that repeat the same ASIN", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      searchPage(titledCard("B0DUPASIN1"), titledCard("B0DUPASIN1"), titledCard("B0OTHERAS1")),
    );
    const results = await searchProducts("q", "US");
    expect(results.map((r) => r.asin)).toEqual(["B0DUPASIN1", "B0OTHERAS1"]);
  });

  it("getProductDetails throws instead of fabricating a product when there is no title", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      detailPage(`<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$19.99</span></span></div>`),
    );
    await expect(getProductDetails("B0DEADPAGE", "US")).rejects.toThrow(/Failed to parse product page for ASIN B0DEADPAGE/);
  });

  it("strips <script> children from #availability and keeps the real text", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      detailPage(`
        <span id="productTitle">Available Product</span>
        <div id="availability"><script>window.ue = {};</script><span>In Stock</span></div>
      `),
    );
    const d = await getProductDetails("B0AVAILOK1", "US");
    expect(d.availability).toBe("In Stock");
  });

  it("nulls out availability text that looks like inline JS instead of returning it", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(
      detailPage(`
        <span id="productTitle">JS Leak Product</span>
        <div id="availability"><span>if (window.ue) { window.ue.count = 1; }</span></div>
      `),
    );
    const d = await getProductDetails("B0AVAILJS1", "US");
    expect(d.availability).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock ONLY fetchHtml; keep parsePrice/extractAsin real via importOriginal so
// getTodaysDeals exercises the actual price-parsing logic against our fixtures.
vi.mock("../src/lib/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/http.js")>();
  return {
    ...actual,
    fetchHtml: vi.fn(),
  };
});

import { getTodaysDeals } from "../src/lib/deals.js";
import { fetchHtml } from "../src/lib/http.js";

const fetchHtmlMock = vi.mocked(fetchHtml);

// ---------------------------------------------------------------------------
// Synthetic Amazon search-result fixtures (cheerio-compatible markup)
// ---------------------------------------------------------------------------

interface CardOpts {
  asin: string;
  title?: string;
  /** Current (deal) price rendered first, like Amazon does. */
  price?: string;
  /** Struck-through list price (.a-price.a-text-price), rendered after the deal price. */
  strikePrice?: string;
  /** Savings badge text, e.g. "-30%". */
  badge?: string;
  img?: string;
}

function card(opts: CardOpts): string {
  const title =
    opts.title === undefined ? "" : `<h2><a href="/dp/${opts.asin}"><span>${opts.title}</span></a></h2>`;
  const price = opts.price
    ? `<span class="a-price"><span class="a-offscreen">${opts.price}</span><span aria-hidden="true">${opts.price}</span></span>`
    : "";
  const strike = opts.strikePrice
    ? `<span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">${opts.strikePrice}</span></span>`
    : "";
  const badge = opts.badge ? `<span class="s-savings-percentage">${opts.badge}</span>` : "";
  const img = opts.img ? `<img class="s-image" src="${opts.img}"/>` : "";
  return `<div data-component-type="s-search-result" data-asin="${opts.asin}">${title}${price}${strike}${badge}${img}</div>`;
}

function page(...cards: string[]): string {
  return `<html><body><div class="s-main-slot">${cards.join("\n")}</div></body></html>`;
}

/** 3 cards: computed 50% discount, no discount at all, explicit "-30%" badge. */
const THREE_CARD_HTML = page(
  card({
    asin: "B0DISCNT50",
    title: "Half Price Blender",
    price: "$50.00",
    strikePrice: "$100.00",
    img: "https://m.media-amazon.com/images/I/blender.jpg",
  }),
  card({ asin: "B0NODEAL00", title: "Plain Full-Price Mug", price: "$30.00" }),
  card({ asin: "B0BADGE300", title: "Badge Deal Toaster", price: "$70.00", badge: "-30%" }),
);

beforeEach(() => {
  fetchHtmlMock.mockReset();
  // Neutralize any locally configured Associates tags so affiliateUrl is deterministic.
  vi.stubEnv("AMAZON_ASSOCIATE_TAG", "");
  vi.stubEnv("AMAZON_ASSOCIATE_TAG_US", "");
  vi.stubEnv("AMAZON_ASSOCIATE_TAG_MX", "");
  vi.stubEnv("AMAZON_ASSOCIATE_TAG_ES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getTodaysDeals — marketplace WITH a deals browse-node (US)", () => {
  it("keeps all parsed cards (no post-filter) and sorts by discount desc, nulls last", async () => {
    fetchHtmlMock.mockResolvedValueOnce(THREE_CARD_HTML);

    const deals = await getTodaysDeals("US");

    // US has a server-side deal node → the no-discount card is NOT filtered out.
    expect(deals).toHaveLength(3);
    expect(deals.map((d) => d.asin)).toEqual(["B0DISCNT50", "B0BADGE300", "B0NODEAL00"]);
    expect(deals.map((d) => d.discountPct)).toEqual([50, 30, null]);
  });

  it("requests the search URL with the US p_n_deal_type node and marketplace acceptLanguage", async () => {
    fetchHtmlMock.mockResolvedValueOnce(THREE_CARD_HTML);

    await getTodaysDeals("US");

    expect(fetchHtmlMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchHtmlMock.mock.calls[0];
    expect(url).toBe("https://www.amazon.com/s?k=deals&rh=p_n_deal_type%3A23566065011");
    expect(opts).toEqual({ acceptLanguage: "en-US,en;q=0.9" });
  });

  it("fills every Deal field: prices, currency, urls, image, null expiry", async () => {
    fetchHtmlMock.mockResolvedValueOnce(THREE_CARD_HTML);

    const [top] = await getTodaysDeals("US");

    expect(top).toMatchObject({
      asin: "B0DISCNT50",
      title: "Half Price Blender",
      url: "https://www.amazon.com/dp/B0DISCNT50",
      dealPrice: 50,
      listPrice: 100,
      discountPct: 50,
      currency: "USD",
      imageUrl: "https://m.media-amazon.com/images/I/blender.jpg",
      expiresAt: null,
      marketplace: "US",
    });
    // No Associates tag configured → affiliate URL is the plain (untagged) product URL.
    expect(top.affiliateUrl).toBe("https://www.amazon.com/dp/B0DISCNT50");
  });

  it("prefers an explicit savings badge over the price-derived discount", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      page(
        card({
          asin: "B0BOTH0001",
          title: "Badge Beats Math",
          price: "$50.00",
          strikePrice: "$100.00", // computed would be 50%
          badge: "-30%", // badge must win
        }),
      ),
    );

    const deals = await getTodaysDeals("US");
    expect(deals).toHaveLength(1);
    expect(deals[0].discountPct).toBe(30);
  });

  it("rounds the computed discount from prices ($29.99 vs $59.99 → 50%)", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      page(card({ asin: "B0ROUND001", title: "Rounded", price: "$29.99", strikePrice: "$59.99" })),
    );

    const deals = await getTodaysDeals("US");
    expect(deals[0].discountPct).toBe(50);
    expect(deals[0].dealPrice).toBe(29.99);
    expect(deals[0].listPrice).toBe(59.99);
  });

  it("ignores an out-of-range badge (>100%) and falls back to price math", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      page(
        card({ asin: "B0BAD99900", title: "Bogus Badge", price: "$75.00", strikePrice: "$100.00", badge: "999%" }),
      ),
    );

    const deals = await getTodaysDeals("US");
    // "999%" is rejected by parseDiscountBadge → computed 25% from the prices.
    expect(deals[0].discountPct).toBe(25);
  });

  it("drops cards without a title and dedupes repeated ASINs", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      page(
        card({ asin: "B0NOTITLE0", price: "$10.00", strikePrice: "$20.00" }), // no <h2> → dropped
        card({ asin: "B0DUPASIN0", title: "First Copy", price: "$40.00", strikePrice: "$80.00" }),
        card({ asin: "B0DUPASIN0", title: "Second Copy", price: "$1.00", strikePrice: "$2.00" }),
      ),
    );

    const deals = await getTodaysDeals("US");
    expect(deals).toHaveLength(1);
    expect(deals[0].asin).toBe("B0DUPASIN0");
    expect(deals[0].title).toBe("First Copy"); // first occurrence wins
  });

  it("applies the limit after sorting, keeping the biggest discounts", async () => {
    fetchHtmlMock.mockResolvedValueOnce(THREE_CARD_HTML);

    const deals = await getTodaysDeals("US", { limit: 2 });
    expect(deals.map((d) => d.asin)).toEqual(["B0DISCNT50", "B0BADGE300"]);
  });

  it("URL-encodes the category keyword into the search query", async () => {
    fetchHtmlMock.mockResolvedValueOnce(page());

    await getTodaysDeals("US", { category: "kitchen & dining" });

    const [url] = fetchHtmlMock.mock.calls[0];
    expect(url).toContain("k=kitchen%20%26%20dining");
  });

  it("parses EU-formatted prices for ES ('1.234,56 €') with the real parsePrice", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      page(card({ asin: "B0EUPRICE0", title: "Cafetera", price: "617,28 €", strikePrice: "1.234,56 €" })),
    );

    const deals = await getTodaysDeals("ES");
    expect(deals).toHaveLength(1);
    expect(deals[0].dealPrice).toBe(617.28);
    expect(deals[0].listPrice).toBe(1234.56);
    expect(deals[0].discountPct).toBe(50);
    expect(deals[0].currency).toBe("EUR");
    // ES has its own deals node in the URL.
    expect(fetchHtmlMock.mock.calls[0][0]).toContain("rh=p_n_deal_type%3A12886766031");
  });
});

describe("getTodaysDeals — marketplace WITHOUT a deals browse-node (MX)", () => {
  it("omits the rh filter from the URL and post-filters cards lacking a discount signal", async () => {
    fetchHtmlMock.mockResolvedValueOnce(THREE_CARD_HTML);

    const deals = await getTodaysDeals("MX");

    const [url] = fetchHtmlMock.mock.calls[0];
    expect(url).toBe("https://www.amazon.com.mx/s?k=deals");
    // The plain full-price card is discarded; strike-through and badge cards survive.
    expect(deals.map((d) => d.asin)).toEqual(["B0DISCNT50", "B0BADGE300"]);
    expect(deals.every((d) => d.marketplace === "MX" && d.currency === "MXN")).toBe(true);
  });

  it("keeps a card whose only discount signal is listPrice > dealPrice (no badge)", async () => {
    fetchHtmlMock.mockResolvedValueOnce(
      page(
        card({ asin: "B0STRIKE01", title: "Struck Only", price: "$80.00", strikePrice: "$100.00" }),
        // listPrice == dealPrice is NOT a discount signal → filtered out.
        card({ asin: "B0EQPRICE0", title: "Equal Prices", price: "$100.00", strikePrice: "$100.00" }),
      ),
    );

    const deals = await getTodaysDeals("MX");
    expect(deals.map((d) => d.asin)).toEqual(["B0STRIKE01"]);
    expect(deals[0].discountPct).toBe(20);
  });
});

describe("getTodaysDeals — filters and failure modes", () => {
  it("minDiscountPct keeps only deals at or above the threshold (nulls excluded)", async () => {
    fetchHtmlMock.mockResolvedValue(THREE_CARD_HTML);

    const atLeast40 = await getTodaysDeals("US", { minDiscountPct: 40 });
    expect(atLeast40.map((d) => d.asin)).toEqual(["B0DISCNT50"]);

    const atLeast30 = await getTodaysDeals("US", { minDiscountPct: 30 });
    expect(atLeast30.map((d) => d.asin)).toEqual(["B0DISCNT50", "B0BADGE300"]);

    // Even a 0 threshold excludes cards with an unknown (null) discount.
    const atLeast0 = await getTodaysDeals("US", { minDiscountPct: 0 });
    expect(atLeast0.map((d) => d.asin)).toEqual(["B0DISCNT50", "B0BADGE300"]);
  });

  it("returns [] when fetchHtml throws (network failure) — never throws", async () => {
    fetchHtmlMock.mockRejectedValueOnce(new Error("Rate limited (HTTP 429)"));
    await expect(getTodaysDeals("US")).resolves.toEqual([]);
  });

  it("returns [] for a page with no search-result cards", async () => {
    fetchHtmlMock.mockResolvedValueOnce("<html><body><p>No results for deals.</p></body></html>");
    await expect(getTodaysDeals("US")).resolves.toEqual([]);
  });

  it("returns [] for an unknown marketplace code without hitting the network", async () => {
    // @ts-expect-error — deliberately invalid marketplace code
    await expect(getTodaysDeals("XX")).resolves.toEqual([]);
    expect(fetchHtmlMock).not.toHaveBeenCalled();
  });
});

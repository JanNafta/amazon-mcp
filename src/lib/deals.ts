import * as cheerio from "cheerio";
import { MARKETPLACES } from "../config.js";
import type { Deal, MarketplaceCode } from "../types.js";
import { buildProductUrl } from "./affiliate.js";
import { fetchHtml, parsePrice } from "./http.js";

// Derive cheerio's types from the return of cheerio.load (see amazon-scraper.ts):
// cheerio 1.2.0 does not export Element from the entry point, so we avoid naming
// internal types. `Selection` is the per-element Cheerio<Element> wrapper.
type CheerioAPI = ReturnType<typeof cheerio.load>;
type Selection = ReturnType<CheerioAPI>;

export interface DealsQuery {
  category?: string;
  minDiscountPct?: number;
  limit?: number;
}

/**
 * Browse-node id for the "Today's Deals" (p_n_deal_type) filter per marketplace.
 * `rh=p_n_deal_type` with no value is a no-op (Amazon ignores it and returns a plain
 * search), so we must pass the marketplace-specific id. These are the stable public
 * ids for each locale's deals node; unknown marketplaces fall back to a post-filter.
 */
const DEAL_TYPE_NODE: Partial<Record<MarketplaceCode, string>> = {
  US: "23566065011",
  UK: "352439011",
  DE: "9439766031",
  FR: "12586581031",
  IT: "12898581031",
  ES: "12886766031",
  CA: "17872973011",
  JP: "2432994051",
};

/** Like firstText but scoped to a single search-result card via .find(). */
function scopedFirstText($card: Selection, selectors: string[]): string | null {
  for (const sel of selectors) {
    const txt = $card.find(sel).first().text().trim();
    if (txt) return txt;
  }
  return null;
}

function scopedFirstAttr($card: Selection, selectors: string[], attr: string): string | null {
  for (const sel of selectors) {
    const val = $card.find(sel).first().attr(attr);
    if (val && val.trim()) return val.trim();
  }
  return null;
}

/** Pull an explicit discount percentage out of a badge/text like "-25%" or "25% off". */
function parseDiscountBadge(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n;
}

/**
 * Fetch today's deals for a marketplace.
 *
 * Amazon's modern goldbox (/deals) and legacy /gp/goldbox pages are heavily
 * JS-rendered and rarely ship usable data in the initial HTML. The pragmatic,
 * robust strategy is to hit the search endpoint with the deals filter
 * (rh=p_n_deal_type), which returns the same server-rendered search cards the
 * normal scraper already understands.
 *
 * Never throws: on any network/parse failure or empty result, returns [].
 */
export async function getTodaysDeals(code: MarketplaceCode, query?: DealsQuery): Promise<Deal[]> {
  const mp = MARKETPLACES[code];
  if (!mp) return [];

  const limit = query?.limit ?? 20;
  const keyword = query?.category || "deals";
  const node = DEAL_TYPE_NODE[code];
  // Pass the marketplace-specific deals browse-node so the filter actually applies.
  // `rh=p_n_deal_type` alone is silently ignored by Amazon (returns a plain search).
  const rh = node ? `&rh=p_n_deal_type%3A${node}` : "";
  const url = `https://${mp.host}/s?k=${encodeURIComponent(keyword)}${rh}`;

  let html: string;
  try {
    html = await fetchHtml(url, { acceptLanguage: mp.acceptLanguage });
  } catch {
    return [];
  }

  let deals: Deal[];
  try {
    deals = parseDeals(html, mp.host, mp.currency, code);
  } catch {
    return [];
  }

  if (deals.length === 0) return [];

  // When we couldn't apply a server-side deals node, keep only cards that actually
  // show a discount signal (a struck-through list price above the deal price, or a
  // parsed discount badge) so results are genuine deals, not a plain keyword search.
  if (!node) {
    deals = deals.filter(
      (d) => d.discountPct != null || (d.listPrice != null && d.dealPrice != null && d.listPrice > d.dealPrice),
    );
  }

  // Optional minimum-discount filter (only applies to cards with a known discount).
  if (typeof query?.minDiscountPct === "number") {
    const threshold = query.minDiscountPct;
    deals = deals.filter((d) => d.discountPct != null && d.discountPct >= threshold);
  }

  // Sort by discount desc, nulls last.
  deals.sort((a, b) => {
    if (a.discountPct == null && b.discountPct == null) return 0;
    if (a.discountPct == null) return 1;
    if (b.discountPct == null) return -1;
    return b.discountPct - a.discountPct;
  });

  return deals.slice(0, limit);
}

/** Parse the deal/search result cards out of an Amazon search page. */
function parseDeals(html: string, host: string, currency: string, code: MarketplaceCode): Deal[] {
  const $ = cheerio.load(html);
  const deals: Deal[] = [];
  const seen = new Set<string>();

  const cards = $('div[data-component-type="s-search-result"][data-asin]');
  cards.each((_i, el) => {
    const $card = $(el);
    const asin = ($card.attr("data-asin") || "").trim();
    if (!asin || seen.has(asin)) return;

    const title = scopedFirstText($card, [
      "h2 a span",
      "h2 span",
      '[data-cy="title-recipe"] span',
      "h2.a-size-mini span",
      "h2",
    ]);
    // Drop cards missing an asin or title.
    if (!asin || !title) return;

    // :not(.a-text-price) so a struck-through list price rendered before the deal
    // price is never read as the deal price itself.
    const dealPrice = parsePrice(
      scopedFirstText($card, [".a-price:not(.a-text-price) .a-offscreen", ".a-price .a-offscreen"]),
    );
    const listPrice = parsePrice(
      scopedFirstText($card, [".a-price.a-text-price .a-offscreen", '[data-a-strike="true"] .a-offscreen']),
    );

    const imageUrl = scopedFirstAttr($card, ["img.s-image"], "src");

    // Discount: prefer an explicit savings badge, otherwise compute from prices.
    // Only read badge-shaped nodes — ".a-color-secondary" was too generic and would
    // capture a stray "%" from unrelated card text.
    let discountPct = parseDiscountBadge(
      scopedFirstText($card, [
        ".s-coupon-highlight-color",
        ".a-badge-label .a-badge-text",
        '[data-a-badge-color] .a-badge-text',
        ".s-savings-percentage",
      ]),
    );
    if (discountPct == null && dealPrice != null && listPrice != null && listPrice > dealPrice) {
      discountPct = Math.round((1 - dealPrice / listPrice) * 100);
    }

    seen.add(asin);
    deals.push({
      asin,
      title,
      url: `https://${host}/dp/${asin}`,
      affiliateUrl: buildProductUrl(asin, code),
      dealPrice,
      listPrice,
      discountPct,
      currency,
      imageUrl,
      // Search cards don't expose deal expiry; left null.
      expiresAt: null,
      marketplace: code,
    });
  });

  return deals;
}

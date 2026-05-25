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
  const url = `https://${mp.host}/s?k=${encodeURIComponent(keyword)}&rh=p_n_deal_type`;

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

    const dealPrice = parsePrice(scopedFirstText($card, [".a-price .a-offscreen"]));
    const listPrice = parsePrice(
      scopedFirstText($card, [".a-price.a-text-price .a-offscreen", '[data-a-strike="true"] .a-offscreen']),
    );

    const imageUrl = scopedFirstAttr($card, ["img.s-image"], "src");

    // Discount: prefer an explicit badge/text, otherwise compute from prices.
    let discountPct = parseDiscountBadge(
      scopedFirstText($card, [".s-coupon-highlight-color", '[class*="deal"] .a-color-price', ".a-color-secondary"]),
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

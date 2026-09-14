import * as cheerio from "cheerio";
import { MARKETPLACES } from "../config.js";
import type { MarketplaceCode, ProductDetails, ProductSummary } from "../types.js";
import { buildProductUrl } from "./affiliate.js";
import { fetchHtml, parsePrice } from "./http.js";

// cheerio's loaded API type. We avoid importing internal type names (which differ
// across cheerio versions / live in domhandler) by deriving everything from the
// return type of cheerio.load. `Selection` is the per-element Cheerio<Element>
// wrapper you get from calling the API, e.g. $("div") or $card.find(sel).
type CheerioAPI = ReturnType<typeof cheerio.load>;
type Selection = ReturnType<CheerioAPI>;

/** Return the trimmed text of the first selector that matches and has non-empty text. */
function firstText($: CheerioAPI, selectors: string[]): string | null {
  for (const sel of selectors) {
    const txt = $(sel).first().text().trim();
    if (txt) return txt;
  }
  return null;
}

/** Return the trimmed value of `attr` for the first selector whose attribute is present. */
function firstAttr($: CheerioAPI, selectors: string[], attr: string): string | null {
  for (const sel of selectors) {
    const val = $(sel).first().attr(attr);
    if (val && val.trim()) return val.trim();
  }
  return null;
}

/** Pull the rating out of a "4.5 out of 5 stars" / "5つ星のうち4.3" style string. */
function parseRating(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // Japanese puts the max first ("5つ星のうち4" = 4 out of 5 stars): the score is the
  // number right after のうち, even when it's an integer — handle it explicitly so the
  // integer fallback below doesn't grab the leading max instead.
  const jp = raw.match(/のうち\s*(\d+(?:[.,]\d+)?)/);
  // Otherwise prefer a short decimal (1–2 fractional digits, not embedded in a longer
  // number — the lookarounds keep "10.5" or a grouped count "1,234" from half-matching)
  // anywhere in the string; only when there's no decimal fall back to a bare integer.
  const m = jp ? [jp[1]] : (raw.match(/(?<!\d)\d+[.,]\d{1,2}(?!\d)/) ?? raw.match(/\d+/));
  if (!m) return null;
  const n = parseFloat(m[0].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  // Sanity clamp: ratings are 0–5.
  return n < 0 || n > 5 ? null : n;
}

/**
 * Parse an integer review/rating count. Strips any "X out of 5 stars" rating segment,
 * expands abbreviations ("1.2K", "1,2 mil", Japanese "1.6万" = 16,000), then takes the
 * last grouped integer — so a combined "4.2 out of 5 stars, 1,234 ratings" → 1234 and a
 * rating-only label ("4.2 out of 5 stars, rating details") → null, never a fabrication.
 */
function parseCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // Drop the rating segment in any supported locale so its numbers can't be mistaken
  // for the count ("4.2 out of 5", "4,5 von 5 Sternen", "5つ星のうち4.2", "4,2 su 5"…).
  const cleaned = raw
    .replace(/\d+(?:[.,]\d+)?\s*(?:out of|von|de|su|sur|van|z|w)\s*5\b[^,;]*/gi, " ")
    .replace(/5\s*つ星のうち\s*\d+(?:[.,]\d+)?/g, " ");
  // Abbreviated: "1.2K", "3M", "1,2 mil", "1,2 Mio.", "2 tys.", JP "1.6万" / "3千".
  const abbr = cleaned.match(/(\d+(?:[.,]\d+)?)\s*(k|mio|m|mil|tys|rb|万|千)(?![a-z])/i);
  if (abbr) {
    const base = parseFloat(abbr[1].replace(",", "."));
    const unit = abbr[2].toLowerCase();
    const mult = unit === "m" || unit === "mio" ? 1_000_000 : unit === "万" ? 10_000 : 1_000;
    const n = Math.round(base * mult);
    return Number.isFinite(n) ? n : null;
  }
  // Take the LAST grouped run of digits (combined aria-labels put the count last),
  // skipping runs shaped like a bare decimal rating ("4.2") — a real count is either
  // a plain integer or grouped in 3s.
  const runs = cleaned.match(/\d[\d.,\s\u00a0\u202f]*\d|\d/g);
  if (!runs || runs.length === 0) return null;
  const candidates = runs.filter((r) => !/^\d+[.,]\d{1,2}$/.test(r.trim()));
  if (candidates.length === 0) return null;
  const digits = candidates[candidates.length - 1].replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Scrape Amazon search results for a query in the given marketplace.
 * Returns up to `limit` product summaries (default 16).
 */
export async function searchProducts(
  query: string,
  code: MarketplaceCode,
  limit = 16,
): Promise<ProductSummary[]> {
  const mp = MARKETPLACES[code];
  const url = `https://${mp.host}/s?k=${encodeURIComponent(query)}`;
  const html = await fetchHtml(url, { acceptLanguage: mp.acceptLanguage });
  const $ = cheerio.load(html);

  const results: ProductSummary[] = [];
  const seen = new Set<string>();

  const cards = $('div[data-component-type="s-search-result"][data-asin]');
  cards.each((_i, el) => {
    if (results.length >= limit) return;
    const $card = $(el);
    const asin = ($card.attr("data-asin") || "").trim();
    if (!asin || seen.has(asin)) return;

    // Title: layouts vary — recent ones nest the text in h2 > a > span, older in
    // h2 > span, and some A/B variants expose [data-cy="title-recipe"].
    const title = scopedFirstText($card, [
      "h2 a span",
      "h2 span",
      '[data-cy="title-recipe"] span',
      "h2.a-size-mini span",
      "h2",
    ]);
    if (!asin || !title) return;

    // :not(.a-text-price) skips the struck-through list price some deal cards render
    // before the real price.
    const price = parsePrice(
      scopedFirstText($card, [".a-price:not(.a-text-price) .a-offscreen", ".a-price .a-offscreen"]),
    );

    const ratingRaw = scopedFirstAttr($card, ["i.a-icon-star-small", "i.a-icon-star", ".a-icon-star-small", ".a-icon-star"], "aria-label")
      ?? scopedFirstText($card, ["i.a-icon-star-small .a-icon-alt", "i.a-icon-star .a-icon-alt", ".a-icon-alt"]);
    const rating = parseRating(ratingRaw);

    // Review count: prefer the underlined text link, fall back to an aria-label
    // on the rating-count anchor.
    const reviewRaw = scopedFirstText($card, [".a-size-base.s-underline-text", "span.s-underline-text"])
      ?? scopedFirstAttr($card, ['a[aria-label*=" rating"]', 'span[aria-label*="rating"]', 'a[href*="customerReviews"]'], "aria-label");
    const reviewCount = parseCount(reviewRaw);

    const imageUrl = scopedFirstAttr($card, ["img.s-image"], "src");

    // Icon badges only exist in the JS-hydrated page; the server-rendered HTML the
    // scraper sees carries Prime membership in the delivery block's text instead.
    const deliveryText = $card.find('[data-cy="delivery-recipe"], .udm-primary-delivery-message, [aria-label*="delivery"]').text();
    const isPrime =
      $card.find("i.a-icon-prime").length > 0 ||
      $card.find('[aria-label="Amazon Prime"]').length > 0 ||
      $card.find(".s-prime").length > 0 ||
      /\bprime\b/i.test(deliveryText);

    seen.add(asin);
    results.push({
      asin,
      title,
      url: `https://${mp.host}/dp/${asin}`,
      affiliateUrl: buildProductUrl(asin, code),
      price,
      currency: mp.currency,
      rating,
      reviewCount,
      imageUrl,
      isPrime,
      marketplace: code,
    });
  });

  if (results.length === 0) {
    // A genuine "no results" page is a valid empty answer, not a failure.
    if (cards.length === 0 && /did not match any products|no results for|No se encontraron resultados|Keine Ergebnisse|Aucun r\u00e9sultat|Nessun risultato/i.test(html)) {
      return [];
    }
    // Otherwise: no cards at all, or cards present but none parsed (layout changed /
    // soft-blocked). Throw instead of returning [] so the empty result is not cached
    // as a success and the caller can report a real failure.
    const detail = cards.length > 0 ? "result cards present but none parsed" : "no result cards found";
    throw new Error(`No search results parsed for "${query}" on ${mp.host} (${detail} — page layout changed or blocked).`);
  }

  return results;
}

/**
 * Clean a #bylineInfo byline into a brand name: collapse internal whitespace and
 * unwrap "Visit the X Store" / "Brand: X" (and localized variants). Author bylines
 * ("Jane Doe (Author)") are not a brand -> null so the caller can try the spec table.
 */
function cleanBrand(byline: string | null): string | null {
  if (!byline) return null;
  const flat = byline.replace(/\s+/g, " ").trim();
  const store = flat.match(/^Visit(?:a|e[zr]?)? (?:the |la |el |lo Store di |den )?(.+?)(?:[- ]Store| Shop)?$/i);
  if (store) return store[1].trim() || null;
  const labeled = flat.match(/^(?:Brand|Marca|Marque|Marke)\s*:\s*(.+)$/i);
  if (labeled) return labeled[1].trim() || null;
  if (/\(Author\)|\(Autor\)|\(Auteur\)/i.test(flat) || /^by /i.test(flat)) return null;
  return flat;
}

/** Scrape a single product detail page. */
export async function getProductDetails(
  asin: string,
  code: MarketplaceCode,
): Promise<ProductDetails> {
  const mp = MARKETPLACES[code];
  const url = `https://${mp.host}/dp/${asin}`;
  const html = await fetchHtml(url, { acceptLanguage: mp.acceptLanguage });
  const $ = cheerio.load(html);

  const title = firstText($, ["#productTitle", "#title", "h1#title span"]);

  // Buybox/core-price selectors FIRST so we read THIS product's price, not the first
  // `.a-price` on the page (which is often a "customers also bought" carousel item).
  let price = parsePrice(
    firstText($, [
      "#corePrice_feature_div .a-offscreen",
      "#corePriceDisplay_desktop_feature_div .a-offscreen",
      "#price_inside_buybox",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#apex_desktop .a-price:not(.a-text-price) .a-offscreen",
      "#centerCol .a-price:not(.a-text-price) .a-offscreen",
      "#buybox .a-price:not(.a-text-price) .a-offscreen",
      ".a-price:not(.a-text-price) .a-offscreen",
      ".a-price .a-offscreen",
    ]),
  );
  // Some layouts leave .a-offscreen empty and render the visible price in split nodes
  // (.a-price-whole + .a-price-fraction). Recover it from those when needed.
  if (price == null) {
    for (const scope of ["#corePrice_desktop", "#corePriceDisplay_desktop_feature_div", "#corePrice_feature_div", "#apex_desktop"]) {
      const whole = $(`${scope} .a-price-whole`).first().text().replace(/[^\d]/g, "");
      const frac = $(`${scope} .a-price-fraction`).first().text().replace(/[^\d]/g, "");
      if (whole) {
        const n = parseFloat(`${whole}.${frac || "0"}`);
        if (Number.isFinite(n)) {
          price = n;
          break;
        }
      }
    }
  }

  const ratingRaw =
    firstAttr($, ["#acrPopover"], "title") ??
    firstText($, ['span[data-hook="rating-out-of-text"]', "#acrPopover .a-icon-alt", "i.a-icon-star .a-icon-alt"]);
  const rating = parseRating(ratingRaw);

  const reviewCount = parseCount(
    firstText($, ["#acrCustomerReviewText", '[data-hook="total-review-count"]']),
  );

  const imageUrl =
    firstAttr($, ["#landingImage"], "data-old-hires") ??
    firstAttr($, ["#landingImage", "#imgBlkFront", "#main-image", "img#main-image"], "src");

  const features: string[] = [];
  $("#feature-bullets ul li span").each((_i, el) => {
    const txt = $(el).text().trim();
    if (txt) features.push(txt);
  });

  // Strip any <script>/<style> children before reading text — dead/error pages
  // sometimes render inline JS inside #availability, which .text() would slurp.
  $("#availability script, #availability style").remove();
  const availabilityRaw = firstText($, ["#availability span", "#availability"]);
  // Drop it only if it still looks like leftover code (real availability strings like
  // "Only 3 left in stock; order soon." contain normal punctuation, so ";" alone must
  // not trip this). The caller clips the length, so no length cap is needed here.
  const availability =
    availabilityRaw && /\bfunction\b|=>|window\.|document\.|var\s+\w+\s*=|\{\s*["'\w]+\s*:/.test(availabilityRaw)
      ? null
      : availabilityRaw;

  // Brand: byline anchor first (unwrapping "Visit the X Store" / "Brand: X" and
  // collapsing internal whitespace), otherwise scan the detail tables for a Brand row.
  // Author-style bylines ("by Jane Doe (Author)") are NOT a brand -> fall through.
  let brand = cleanBrand(firstText($, ["#bylineInfo"]));
  if (!brand) {
    brand = findTableValue($, ["brand", "marca", "marque", "marke"]);
  }

  const byline = firstText($, ["#bylineInfo", "#bylineInfo_feature_div"]);

  const breadcrumbs: string[] = [];
  $("#wayfinding-breadcrumbs_feature_div ul li a").each((_i, el) => {
    const txt = $(el).text().trim();
    if (txt) breadcrumbs.push(txt);
  });

  // Scope the Prime badge to the buybox/delivery area so we don't pick up a Prime
  // icon from an unrelated "customers also bought" carousel on the same page.
  const isPrime =
    $("#primeBadge").length > 0 ||
    $("#buybox i.a-icon-prime, #desktop_buybox i.a-icon-prime, #ppd i.a-icon-prime, #priceBadging_feature_div i.a-icon-prime, #deliveryBlockMessage i.a-icon-prime").length > 0;

  // A real product page always has a title. Without one we can't tell whether the
  // price/Prime we scraped belong to this ASIN (dead pages leak carousel data), so
  // refuse rather than fabricate an incoherent product.
  if (!title) {
    throw new Error(`Failed to parse product page for ASIN ${asin} on ${mp.host} (layout changed or blocked).`);
  }

  return {
    asin,
    title: title ?? "",
    url: `https://${mp.host}/dp/${asin}`,
    affiliateUrl: buildProductUrl(asin, code),
    price,
    currency: mp.currency,
    rating,
    reviewCount,
    imageUrl,
    isPrime,
    marketplace: code,
    features,
    availability,
    brand,
    byline,
    breadcrumbs,
  };
}

/**
 * Scan Amazon's product detail / technical specification tables for a value whose
 * row label matches one of the given (lowercased) keys, e.g. "brand".
 */
function findTableValue($: CheerioAPI, keys: string[]): string | null {
  let found: string | null = null;
  $(
    "#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #detailBullets_feature_div li, table.a-keyvalue tr, .prodDetTable tr",
  ).each((_i, el) => {
    if (found) return;
    const $row = $(el);
    const label = ($row.find("th").first().text() || $row.find(".a-text-bold").first().text())
      .replace(/[\s\u00a0:]+/g, " ")
      .trim()
      .toLowerCase();
    if (!label) return;
    if (keys.some((k) => label.includes(k))) {
      const value = $row.find("td").first().text().trim() || $row.find("span").last().text().trim();
      if (value) found = value;
    }
  });
  return found;
}

/** Like firstText but scoped to a single search-result card via .find(). */
function scopedFirstText(
  $card: Selection,
  selectors: string[],
): string | null {
  for (const sel of selectors) {
    const txt = $card.find(sel).first().text().trim();
    if (txt) return txt;
  }
  return null;
}

function scopedFirstAttr(
  $card: Selection,
  selectors: string[],
  attr: string,
): string | null {
  for (const sel of selectors) {
    const val = $card.find(sel).first().attr(attr);
    if (val && val.trim()) return val.trim();
  }
  return null;
}

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

/** Pull the first decimal number out of a "4.5 out of 5 stars" style string. */
function parseRating(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // Match "4.5", "4,5" etc.
  const m = raw.match(/(\d+[.,]\d+|\d+)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  // Sanity clamp: ratings are 0–5.
  return n > 5 ? null : n;
}

/** Parse an integer review/rating count, stripping thousands separators. */
function parseCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
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

    const price = parsePrice(scopedFirstText($card, [".a-price .a-offscreen"]));

    const ratingRaw = scopedFirstAttr($card, ["i.a-icon-star-small", "i.a-icon-star", ".a-icon-star-small", ".a-icon-star"], "aria-label")
      ?? scopedFirstText($card, ["i.a-icon-star-small .a-icon-alt", "i.a-icon-star .a-icon-alt", ".a-icon-alt"]);
    const rating = parseRating(ratingRaw);

    // Review count: prefer the underlined text link, fall back to an aria-label
    // on the rating-count anchor.
    const reviewRaw = scopedFirstText($card, [".a-size-base.s-underline-text", "span.s-underline-text"])
      ?? scopedFirstAttr($card, ['a[aria-label*=" rating"]', 'span[aria-label*="rating"]', 'a[href*="customerReviews"]'], "aria-label");
    const reviewCount = parseCount(reviewRaw);

    const imageUrl = scopedFirstAttr($card, ["img.s-image"], "src");

    const isPrime =
      $card.find("i.a-icon-prime").length > 0 ||
      $card.find('[aria-label="Amazon Prime"]').length > 0 ||
      $card.find(".aok-relative.s-icon-text-margin-right i.a-icon-prime").length > 0 ||
      $card.find(".s-prime").length > 0;

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

  if (results.length === 0 && cards.length === 0) {
    // Neither a parseable title nor any result cards: treat the page as unusable.
    throw new Error(`No search results parsed for "${query}" on ${mp.host} (page layout changed or blocked).`);
  }

  return results;
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

  let price = parsePrice(
    firstText($, [
      ".a-price .a-offscreen",
      "#corePrice_feature_div .a-offscreen",
      "#corePriceDisplay_desktop_feature_div .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#price_inside_buybox",
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

  const availability = firstText($, ["#availability span", "#availability"]);

  // Brand: byline anchor first, otherwise scan the product detail tables for a "Brand" row.
  let brand = firstText($, ["#bylineInfo"]);
  if (!brand) {
    brand = findTableValue($, ["brand", "marca", "marque", "marke"]);
  }

  const byline = firstText($, ["#bylineInfo", "#bylineInfo_feature_div"]);

  const breadcrumbs: string[] = [];
  $("#wayfinding-breadcrumbs_feature_div ul li a").each((_i, el) => {
    const txt = $(el).text().trim();
    if (txt) breadcrumbs.push(txt);
  });

  const isPrime = $("#primeBadge").length > 0 || $("i.a-icon-prime").length > 0;

  if (!title && features.length === 0 && !price) {
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
      .replace(/[\s :]+/g, " ")
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

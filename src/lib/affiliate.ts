import { MARKETPLACES, PLACEHOLDER_TAG, resolveMarketplace } from "../config.js";
import type { BuyLink, MarketplaceCode } from "../types.js";

/**
 * Resolve the Amazon Associates tag for a marketplace.
 *
 * Reads AMAZON_ASSOCIATE_TAG_<CODE> from the environment (e.g. AMAZON_ASSOCIATE_TAG_US).
 * Falls back to the generic AMAZON_ASSOCIATE_TAG, then to the placeholder.
 *
 * The associate tag is what earns commission: when a buyer lands on Amazon through a
 * tagged link, Amazon drops a 24h tracking cookie and credits any purchase in that window.
 */
export function resolveAssociateTag(code: MarketplaceCode): { tag: string; isPlaceholder: boolean } {
  const specific = process.env[`AMAZON_ASSOCIATE_TAG_${code}`]?.trim();
  const generic = process.env.AMAZON_ASSOCIATE_TAG?.trim();
  const tag = specific || generic;
  if (tag) return { tag, isPlaceholder: false };
  return { tag: PLACEHOLDER_TAG, isPlaceholder: true };
}

/** Append/replace the affiliate tag on any Amazon URL, preserving other query params. */
export function withAffiliateTag(url: string, code: MarketplaceCode): string {
  const { tag } = resolveAssociateTag(code);
  try {
    const u = new URL(url);
    u.searchParams.set("tag", tag);
    // linkCode + ascsubtag are standard Associates params; linkCode=ll1 marks a text link.
    if (!u.searchParams.has("linkCode")) u.searchParams.set("linkCode", "ll1");
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}tag=${encodeURIComponent(tag)}&linkCode=ll1`;
  }
}

/** Canonical product detail URL with affiliate tag. */
export function buildProductUrl(asin: string, code: MarketplaceCode): string {
  const mp = MARKETPLACES[code] ?? resolveMarketplace(code);
  return withAffiliateTag(`https://${mp.host}/dp/${asin}`, code);
}

/**
 * One-click add-to-cart URL. Amazon's /gp/aws/cart/add.html endpoint accepts the
 * associate tag, so the cookie is set the moment the buyer opens the link.
 */
export function buildAddToCartUrl(asin: string, code: MarketplaceCode, quantity = 1): string {
  const mp = MARKETPLACES[code] ?? resolveMarketplace(code);
  const { tag } = resolveAssociateTag(code);
  const params = new URLSearchParams({
    "ASIN.1": asin,
    "Quantity.1": String(quantity),
    AssociateTag: tag,
    tag,
  });
  return `https://${mp.host}/gp/aws/cart/add.html?${params.toString()}`;
}

/** Affiliate search URL (so even browsing results drops the cookie). */
export function buildSearchUrl(query: string, code: MarketplaceCode): string {
  const mp = MARKETPLACES[code] ?? resolveMarketplace(code);
  return withAffiliateTag(`https://${mp.host}/s?k=${encodeURIComponent(query)}`, code);
}

/** Full buy-link bundle for a product, ready to hand to the user. */
export function buildBuyLink(asin: string, code: MarketplaceCode, quantity = 1): BuyLink {
  const { tag, isPlaceholder } = resolveAssociateTag(code);
  return {
    asin,
    marketplace: code,
    productUrl: buildProductUrl(asin, code),
    addToCartUrl: buildAddToCartUrl(asin, code, quantity),
    associateTag: tag,
    usingPlaceholderTag: isPlaceholder,
    note: isPlaceholder
      ? `Using placeholder tag "${tag}" — you earn NO commission. Set AMAZON_ASSOCIATE_TAG_${code} to your real Associates tag.`
      : `Affiliate tag "${tag}" applied. Purchases within 24h of opening this link earn you commission.`,
  };
}

import { MARKETPLACES, resolveMarketplace } from "../config.js";
import type { BuyLink, MarketplaceCode } from "../types.js";

/**
 * Resolve the Amazon Associates tag for a marketplace.
 *
 * Reads AMAZON_ASSOCIATE_TAG_<CODE> (e.g. AMAZON_ASSOCIATE_TAG_ES), then falls back to
 * the generic AMAZON_ASSOCIATE_TAG. Returns null when nothing is configured — links are
 * then emitted untagged (still valid, just no commission).
 *
 * The tag is what earns commission: when a buyer lands on Amazon through a tagged link,
 * Amazon drops a 24h tracking cookie and credits any purchase in that window. Always
 * configure it via the environment (e.g. a local, git-ignored .env) — never in source.
 */
/** A syntactically valid Associates tag: alphanumerics and hyphens, e.g. "mysite-21". */
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/i;

export function resolveAssociateTag(code: MarketplaceCode): string | null {
  const specific = process.env[`AMAZON_ASSOCIATE_TAG_${code}`]?.trim();
  const generic = process.env.AMAZON_ASSOCIATE_TAG?.trim();
  const tag = specific || generic || null;
  // Reject malformed tags (spaces, inline comment leftovers, etc.) instead of
  // silently URL-encoding them into something Amazon won't credit.
  if (tag && !TAG_RE.test(tag)) return null;
  return tag;
}

/**
 * Whether the resolved tag matches this marketplace's expected suffix (e.g. US tags
 * end in "-20", most EU in "-21"). Each Associates program is per-country: a "-20"
 * tag used on amazon.es earns no commission. Returns null when there is no tag or its
 * shape is unusual — callers use this only to warn, never to block a link.
 */
export function tagMatchesMarketplace(tag: string | null, code: MarketplaceCode): boolean | null {
  if (!tag) return null;
  const suffix = MARKETPLACES[code]?.tagSuffix;
  if (!suffix) return null;
  const m = tag.match(/-(\d+)$/);
  if (!m) return null;
  return m[1] === suffix;
}

/** Append the affiliate tag to an Amazon URL when one is configured, preserving other params. */
export function withAffiliateTag(url: string, code: MarketplaceCode): string {
  const tag = resolveAssociateTag(code);
  try {
    const u = new URL(url);
    if (tag) {
      u.searchParams.set("tag", tag);
      // linkCode=ll1 marks a standard Associates text link.
      if (!u.searchParams.has("linkCode")) u.searchParams.set("linkCode", "ll1");
    }
    return u.toString();
  } catch {
    if (!tag) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}tag=${encodeURIComponent(tag)}&linkCode=ll1`;
  }
}

/** Canonical product detail URL, affiliate-tagged when a tag is configured. */
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
  const tag = resolveAssociateTag(code);
  const params = new URLSearchParams({ "ASIN.1": asin, "Quantity.1": String(quantity) });
  if (tag) {
    params.set("AssociateTag", tag);
    params.set("tag", tag);
  }
  return `https://${mp.host}/gp/aws/cart/add.html?${params.toString()}`;
}

/** Affiliate search URL (so even browsing results drops the cookie). */
export function buildSearchUrl(query: string, code: MarketplaceCode): string {
  const mp = MARKETPLACES[code] ?? resolveMarketplace(code);
  return withAffiliateTag(`https://${mp.host}/s?k=${encodeURIComponent(query)}`, code);
}

/** Full buy-link bundle for a product, ready to hand to the user. */
export function buildBuyLink(asin: string, code: MarketplaceCode, quantity = 1): BuyLink {
  const tag = resolveAssociateTag(code);
  const suffixOk = tagMatchesMarketplace(tag, code);

  let note: string;
  if (!tag) {
    const rawSpecific = process.env[`AMAZON_ASSOCIATE_TAG_${code}`]?.trim();
    const rawGeneric = process.env.AMAZON_ASSOCIATE_TAG?.trim();
    note =
      rawSpecific || rawGeneric
        ? `The configured Associates tag is malformed (tags allow only letters, digits and hyphens) — link works but earns no commission. Check AMAZON_ASSOCIATE_TAG_${code} / AMAZON_ASSOCIATE_TAG for stray spaces or comments.`
        : `No Associates tag configured for ${code} — link still works but earns no commission. Set AMAZON_ASSOCIATE_TAG_${code} (or AMAZON_ASSOCIATE_TAG) in your local .env.`;
  } else if (suffixOk === false) {
    note = `Tag "${tag}" doesn't match Amazon ${code}'s program (expected suffix -${MARKETPLACES[code].tagSuffix}). Each Associates program is per-country, so this link likely earns NO commission on ${code}. Set AMAZON_ASSOCIATE_TAG_${code} to your ${code} tag.`;
  } else {
    note = "Affiliate tag applied. Purchases within 24h of opening this link earn you commission.";
  }

  return {
    asin,
    marketplace: code,
    productUrl: buildProductUrl(asin, code),
    addToCartUrl: buildAddToCartUrl(asin, code, quantity),
    associateTag: tag,
    // "tagged" now means "will actually earn commission": a real, correctly-suffixed tag.
    tagged: tag !== null && suffixOk !== false,
    note,
  };
}

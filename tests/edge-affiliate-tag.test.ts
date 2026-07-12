import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAddToCartUrl,
  buildBuyLink,
  buildProductUrl,
  resolveAssociateTag,
  tagMatchesMarketplace,
  withAffiliateTag,
} from "../src/lib/affiliate.js";

/** Every test stubs both env vars explicitly so a real .env can never leak in. */
function stubTags(specificVar: string, specific: string, generic = "") {
  vi.stubEnv(specificVar, specific);
  vi.stubEnv("AMAZON_ASSOCIATE_TAG", generic);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAssociateTag — malformed tag hardening", () => {
  it("rejects a tag containing a space (→ null, not URL-encoded garbage)", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_ES", "bad tag-21");
    expect(resolveAssociateTag("ES")).toBeNull();
  });

  it("rejects a tag with an inline-comment leftover (# character)", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_US", "myshop-20 # prod tag");
    expect(resolveAssociateTag("US")).toBeNull();
  });

  it("treats whitespace-only specific tag as unset and falls back to the generic tag", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_US", "   ", "generic-20");
    expect(resolveAssociateTag("US")).toBe("generic-20");
  });

  it("returns null when both specific and generic are empty after trim", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_US", "  ", "");
    expect(resolveAssociateTag("US")).toBeNull();
  });

  it("accepts a well-formed tag and trims surrounding whitespace", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_US", "  myshop-20  ");
    expect(resolveAssociateTag("US")).toBe("myshop-20");
  });

  it("a malformed SPECIFIC tag does NOT fall back to a valid generic tag (specific wins, then fails validation)", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_ES", "bad tag-21", "good-21");
    expect(resolveAssociateTag("ES")).toBeNull();
  });
});

describe("tagMatchesMarketplace — per-country suffix check", () => {
  it('"myshop-20" matches US (suffix 20) but not ES (suffix 21)', () => {
    expect(tagMatchesMarketplace("myshop-20", "US")).toBe(true);
    expect(tagMatchesMarketplace("myshop-20", "ES")).toBe(false);
  });

  it('"x-21" matches ES', () => {
    expect(tagMatchesMarketplace("x-21", "ES")).toBe(true);
  });

  it("returns null for a null tag and for a tag without a numeric suffix", () => {
    expect(tagMatchesMarketplace(null, "US")).toBeNull();
    expect(tagMatchesMarketplace("myshop", "US")).toBeNull();
  });

  it("uses each marketplace's own suffix (JP=22, so a -21 tag mismatches)", () => {
    expect(tagMatchesMarketplace("jptag-22", "JP")).toBe(true);
    expect(tagMatchesMarketplace("eutag-21", "JP")).toBe(false);
  });

  it("only the FINAL numeric suffix counts (digits mid-tag don't confuse it)", () => {
    expect(tagMatchesMarketplace("shop24-7-20", "US")).toBe(true);
    expect(tagMatchesMarketplace("shop24-7-20", "ES")).toBe(false);
  });
});

describe("buildBuyLink — tagged flag + note per scenario", () => {
  it("US tag on ES marketplace → tagged:false with a suffix-mismatch warning note", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_ES", "myshop-20");
    const link = buildBuyLink("B08N5WRWNW", "ES");
    expect(link.tagged).toBe(false);
    expect(link.associateTag).toBe("myshop-20");
    expect(link.note).toContain("expected suffix -21");
    expect(link.note).toContain("NO commission");
    // The tag is still injected into the URLs (warn, never block).
    expect(new URL(link.productUrl).searchParams.get("tag")).toBe("myshop-20");
  });

  it("US tag on US marketplace → tagged:true with the commission note", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_US", "myshop-20");
    const link = buildBuyLink("B08N5WRWNW", "US");
    expect(link.tagged).toBe(true);
    expect(link.note).toContain("commission");
    expect(link.note).toContain("24h");
  });

  it("no tag at all → tagged:false and 'No Associates tag' note", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_US", "");
    const link = buildBuyLink("B08N5WRWNW", "US");
    expect(link.tagged).toBe(false);
    expect(link.associateTag).toBeNull();
    expect(link.note).toContain("No Associates tag");
  });

  it("malformed tag → tagged:false and a note mentioning 'malformed' (distinct from the unset case)", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_US", "bad tag-20");
    const link = buildBuyLink("B08N5WRWNW", "US");
    expect(link.tagged).toBe(false);
    expect(link.associateTag).toBeNull();
    expect(link.note).toContain("malformed");
    // Malformed tag must never leak into the emitted URLs.
    expect(link.productUrl).not.toContain("bad");
    expect(new URL(link.productUrl).searchParams.get("tag")).toBeNull();
  });

  it("tag with an unusual shape (no numeric suffix) → suffix check is inconclusive, so tagged stays true", () => {
    stubTags("AMAZON_ASSOCIATE_TAG_US", "myshop");
    const link = buildBuyLink("B08N5WRWNW", "US");
    expect(link.tagged).toBe(true);
    expect(link.associateTag).toBe("myshop");
  });
});

describe("URL builders — tag injection mechanics", () => {
  beforeEach(() => {
    stubTags("AMAZON_ASSOCIATE_TAG_US", "myshop-20");
  });

  it("withAffiliateTag sets tag + linkCode=ll1 and preserves existing params", () => {
    const u = new URL(withAffiliateTag("https://www.amazon.com/s?k=mouse", "US"));
    expect(u.searchParams.get("tag")).toBe("myshop-20");
    expect(u.searchParams.get("linkCode")).toBe("ll1");
    expect(u.searchParams.get("k")).toBe("mouse");
  });

  it("withAffiliateTag keeps a pre-existing linkCode instead of overwriting it", () => {
    const u = new URL(withAffiliateTag("https://www.amazon.com/dp/B01?linkCode=sl2", "US"));
    expect(u.searchParams.get("linkCode")).toBe("sl2");
    expect(u.searchParams.get("tag")).toBe("myshop-20");
  });

  it("withAffiliateTag falls back to string appending for unparsable URLs", () => {
    expect(withAffiliateTag("/dp/B08N5WRWNW", "US")).toBe("/dp/B08N5WRWNW?tag=myshop-20&linkCode=ll1");
    expect(withAffiliateTag("/dp/B08N5WRWNW?th=1", "US")).toBe("/dp/B08N5WRWNW?th=1&tag=myshop-20&linkCode=ll1");
  });

  it("withAffiliateTag returns an unparsable URL untouched when no tag resolves", () => {
    vi.stubEnv("AMAZON_ASSOCIATE_TAG_US", "");
    expect(withAffiliateTag("/dp/B08N5WRWNW", "US")).toBe("/dp/B08N5WRWNW");
  });

  it("buildProductUrl emits the canonical /dp/ URL with tag + linkCode=ll1", () => {
    const u = new URL(buildProductUrl("B08N5WRWNW", "US"));
    expect(u.host).toBe("www.amazon.com");
    expect(u.pathname).toBe("/dp/B08N5WRWNW");
    expect(u.searchParams.get("tag")).toBe("myshop-20");
    expect(u.searchParams.get("linkCode")).toBe("ll1");
  });

  it("buildAddToCartUrl carries ASIN.1, Quantity.1 and both tag params", () => {
    const u = new URL(buildAddToCartUrl("B08N5WRWNW", "US", 2));
    expect(u.pathname).toBe("/gp/aws/cart/add.html");
    expect(u.searchParams.get("ASIN.1")).toBe("B08N5WRWNW");
    expect(u.searchParams.get("Quantity.1")).toBe("2");
    expect(u.searchParams.get("AssociateTag")).toBe("myshop-20");
    expect(u.searchParams.get("tag")).toBe("myshop-20");
  });

  it("buildAddToCartUrl with a malformed tag drops BOTH AssociateTag and tag", () => {
    vi.stubEnv("AMAZON_ASSOCIATE_TAG_US", "bad#tag-20");
    const u = new URL(buildAddToCartUrl("B08N5WRWNW", "US"));
    expect(u.searchParams.get("AssociateTag")).toBeNull();
    expect(u.searchParams.get("tag")).toBeNull();
    expect(u.searchParams.get("ASIN.1")).toBe("B08N5WRWNW");
  });
});

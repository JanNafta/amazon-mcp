import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLACEHOLDER_TAG } from "../src/config.js";
import {
  buildAddToCartUrl,
  buildBuyLink,
  buildProductUrl,
  buildSearchUrl,
  resolveAssociateTag,
  withAffiliateTag,
} from "../src/lib/affiliate.js";

describe("affiliate — with AMAZON_ASSOCIATE_TAG_US set", () => {
  beforeEach(() => {
    vi.stubEnv("AMAZON_ASSOCIATE_TAG_US", "mytag-20");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("withAffiliateTag injects the configured tag", () => {
    const out = withAffiliateTag("https://www.amazon.com/dp/B08N5WRWNW", "US");
    const u = new URL(out);
    expect(u.searchParams.get("tag")).toBe("mytag-20");
  });

  it("resolveAssociateTag reports isPlaceholder=false when configured", () => {
    const { tag, isPlaceholder } = resolveAssociateTag("US");
    expect(tag).toBe("mytag-20");
    expect(isPlaceholder).toBe(false);
  });

  it("buildBuyLink reports usingPlaceholderTag=false", () => {
    const link = buildBuyLink("B08N5WRWNW", "US");
    expect(link.usingPlaceholderTag).toBe(false);
    expect(link.associateTag).toBe("mytag-20");
  });
});

describe("affiliate — without any tag env (placeholder fallback)", () => {
  beforeEach(() => {
    // Ensure no leaked env from the shell/process.
    vi.stubEnv("AMAZON_ASSOCIATE_TAG_US", "");
    vi.stubEnv("AMAZON_ASSOCIATE_TAG", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("withAffiliateTag falls back to the placeholder tag", () => {
    const out = withAffiliateTag("https://www.amazon.com/dp/B08N5WRWNW", "US");
    const u = new URL(out);
    expect(u.searchParams.get("tag")).toBe(PLACEHOLDER_TAG);
  });

  it("resolveAssociateTag reports isPlaceholder=true", () => {
    const { tag, isPlaceholder } = resolveAssociateTag("US");
    expect(tag).toBe(PLACEHOLDER_TAG);
    expect(isPlaceholder).toBe(true);
  });

  it("buildBuyLink reports usingPlaceholderTag=true and note mentions placeholder", () => {
    const link = buildBuyLink("B08N5WRWNW", "US");
    expect(link.usingPlaceholderTag).toBe(true);
    expect(link.note.toLowerCase()).toContain("placeholder");
  });
});

describe("withAffiliateTag — query param handling", () => {
  beforeEach(() => {
    vi.stubEnv("AMAZON_ASSOCIATE_TAG_US", "mytag-20");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves existing query params", () => {
    const out = withAffiliateTag("https://www.amazon.com/s?k=phone&rh=p_72", "US");
    const u = new URL(out);
    expect(u.searchParams.get("k")).toBe("phone");
    expect(u.searchParams.get("rh")).toBe("p_72");
    expect(u.searchParams.get("tag")).toBe("mytag-20");
  });

  it("replaces a pre-existing tag with the resolved one", () => {
    const out = withAffiliateTag("https://www.amazon.com/dp/B08N5WRWNW?tag=old-20", "US");
    const u = new URL(out);
    expect(u.searchParams.get("tag")).toBe("mytag-20");
    // No duplicate tag params.
    expect(u.searchParams.getAll("tag")).toEqual(["mytag-20"]);
  });
});

describe("buildProductUrl — host per marketplace", () => {
  beforeEach(() => {
    vi.stubEnv("AMAZON_ASSOCIATE_TAG_ES", "estag-21");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("produces an amazon.es /dp/ URL with the tag for ES", () => {
    const out = buildProductUrl("B08N5WRWNW", "ES");
    const u = new URL(out);
    expect(u.host).toBe("www.amazon.es");
    expect(u.pathname).toBe("/dp/B08N5WRWNW");
    expect(u.searchParams.get("tag")).toBe("estag-21");
  });
});

describe("buildAddToCartUrl", () => {
  beforeEach(() => {
    vi.stubEnv("AMAZON_ASSOCIATE_TAG_US", "mytag-20");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("contains ASIN.1, Quantity.1, AssociateTag and the correct host", () => {
    const out = buildAddToCartUrl("B08N5WRWNW", "US", 3);
    expect(out).toContain("https://www.amazon.com/gp/aws/cart/add.html");
    const u = new URL(out);
    expect(u.searchParams.get("ASIN.1")).toBe("B08N5WRWNW");
    expect(u.searchParams.get("Quantity.1")).toBe("3");
    expect(u.searchParams.get("AssociateTag")).toBe("mytag-20");
    expect(u.searchParams.get("tag")).toBe("mytag-20");
  });

  it("defaults quantity to 1", () => {
    const out = buildAddToCartUrl("B08N5WRWNW", "US");
    const u = new URL(out);
    expect(u.searchParams.get("Quantity.1")).toBe("1");
  });
});

describe("buildSearchUrl + cross-marketplace hosts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("buildSearchUrl encodes the query and tags it", () => {
    vi.stubEnv("AMAZON_ASSOCIATE_TAG_US", "mytag-20");
    const out = buildSearchUrl("wireless mouse", "US");
    const u = new URL(out);
    expect(u.host).toBe("www.amazon.com");
    expect(u.pathname).toBe("/s");
    expect(u.searchParams.get("k")).toBe("wireless mouse");
    expect(u.searchParams.get("tag")).toBe("mytag-20");
  });

  it("different marketplaces resolve to different hosts", () => {
    expect(new URL(buildProductUrl("B000000001", "US")).host).toBe("www.amazon.com");
    expect(new URL(buildProductUrl("B000000001", "UK")).host).toBe("www.amazon.co.uk");
    expect(new URL(buildProductUrl("B000000001", "DE")).host).toBe("www.amazon.de");
  });
});

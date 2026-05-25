import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the http module: keep the real pure helpers (parsePrice, extractAsin),
// only replace the network-bound fetchHtml.
vi.mock("../src/lib/http.js", async (orig) => {
  const actual = await orig<typeof import("../src/lib/http.js")>();
  return { ...actual, fetchHtml: vi.fn() };
});

import { fetchHtml } from "../src/lib/http.js";
import { searchProducts } from "../src/lib/amazon-scraper.js";

const FIXTURE_HTML = `
<!DOCTYPE html>
<html>
  <body>
    <div class="s-main-slot">
      <div data-component-type="s-search-result" data-asin="B01EXAMPLE1">
        <h2><a href="/dp/B01EXAMPLE1"><span>Test Product</span></a></h2>
        <span class="a-price"><span class="a-offscreen">$19.99</span></span>
        <img class="s-image" src="http://img/x.jpg" />
      </div>
    </div>
  </body>
</html>
`;

describe("searchProducts (mocked network)", () => {
  beforeEach(() => {
    vi.mocked(fetchHtml).mockReset();
    vi.stubEnv("AMAZON_ASSOCIATE_TAG_US", "mytag-20");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses a single search-result card", async () => {
    vi.mocked(fetchHtml).mockResolvedValue(FIXTURE_HTML);

    const results = await searchProducts("x", "US");
    expect(results).toHaveLength(1);

    const p = results[0];
    expect(p.asin).toBe("B01EXAMPLE1");
    expect(p.title).toBe("Test Product");
    expect(p.price).toBe(19.99);
    expect(p.currency).toBe("USD");
    expect(p.marketplace).toBe("US");
    expect(p.imageUrl).toBe("http://img/x.jpg");
    expect(p.affiliateUrl).toContain("tag=mytag-20");
    expect(p.affiliateUrl).toContain("/dp/B01EXAMPLE1");
  });

  it("respects the limit argument", async () => {
    const twoCards = FIXTURE_HTML.replace(
      "</div>\n    </div>",
      `</div>
       <div data-component-type="s-search-result" data-asin="B01EXAMPLE2">
         <h2><a href="/dp/B01EXAMPLE2"><span>Second Product</span></a></h2>
         <span class="a-price"><span class="a-offscreen">$5.00</span></span>
       </div>
     </div>`,
    );
    vi.mocked(fetchHtml).mockResolvedValue(twoCards);

    const results = await searchProducts("x", "US", 1);
    expect(results).toHaveLength(1);
    expect(results[0].asin).toBe("B01EXAMPLE1");
  });
});

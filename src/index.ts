#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Minimal .env loader (no dependency). Useful for local `npm run dev`.
// In production, MCP clients pass env vars via their config "env" block.
(function loadDotEnv() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(process.cwd(), ".env"), join(here, "..", ".env")];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (val !== "" && process.env[m[1]] === undefined) process.env[m[1]] = val;
      }
      break;
    }
  } catch {
    /* ignore */
  }
})();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig, MARKETPLACES } from "./config.js";
import type { MarketplaceCode, PriceHistory } from "./types.js";
import { buildBuyLink } from "./lib/affiliate.js";
import { searchProducts, getProductDetails } from "./lib/amazon-scraper.js";
import { getPriceHistory } from "./lib/camelcamelcamel.js";
import { getTodaysDeals } from "./lib/deals.js";
import {
  getOrFetch,
  logPrice,
  getPriceLog,
  addWatch,
  listWatches,
  removeWatch,
  updateWatchPrice,
} from "./lib/cache.js";

const config = loadConfig();
const MARKETPLACE_CODES = Object.keys(MARKETPLACES) as [MarketplaceCode, ...MarketplaceCode[]];

const marketplaceSchema = z
  .enum(MARKETPLACE_CODES)
  .optional()
  .describe(`Amazon marketplace. One of ${MARKETPLACE_CODES.join(", ")}. Defaults to ${config.defaultMarketplace}.`);

function mp(code?: MarketplaceCode): MarketplaceCode {
  return code ?? config.defaultMarketplace;
}

function money(n: number | null, currency: string): string {
  return n == null ? "—" : `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errorText(t: string) {
  return { content: [{ type: "text" as const, text: t }], isError: true };
}

const server = new McpServer({ name: "amazon-mcp", version: "0.1.0" });

// ───────────────────────────────────────────────────────────── search_products
server.registerTool(
  "search_products",
  {
    title: "Search Amazon products",
    description:
      "Search Amazon for products by keyword. Returns title, price, rating, image and an AFFILIATE purchase link (with your Associates tag) for each result.",
    inputSchema: {
      query: z.string().min(1).describe("Search keywords, e.g. 'mechanical keyboard'"),
      marketplace: marketplaceSchema,
      limit: z.number().int().min(1).max(40).optional().describe("Max results (default 16)"),
    },
  },
  async ({ query, marketplace, limit }) => {
    const code = mp(marketplace);
    try {
      const key = `search:${code}:${limit ?? 16}:${query.toLowerCase()}`;
      const results = await getOrFetch(key, config.cacheTtlProduct, () => searchProducts(query, code, limit ?? 16));
      if (results.length === 0) return text(`No results for "${query}" on Amazon ${code}.`);

      const lines = results.map((p, i) => {
        const rating = p.rating != null ? `★${p.rating}${p.reviewCount != null ? ` (${p.reviewCount.toLocaleString()})` : ""}` : "";
        return `${i + 1}. ${p.title}\n   ${money(p.price, p.currency)}  ${rating}  ${p.isPrime ? "✓Prime" : ""}\n   ASIN: ${p.asin}\n   Buy (affiliate): ${p.affiliateUrl}`;
      });
      return text(`Top ${results.length} results for "${query}" on Amazon ${code}:\n\n${lines.join("\n\n")}`);
    } catch (e) {
      return errorText(`Search failed on Amazon ${code}: ${(e as Error).message}`);
    }
  },
);

// ───────────────────────────────────────────────────────────────── get_product
server.registerTool(
  "get_product",
  {
    title: "Get Amazon product details",
    description:
      "Fetch full details for a product by ASIN: title, price, rating, features, availability, brand, breadcrumbs, plus an affiliate buy link. Also logs the price to local history.",
    inputSchema: {
      asin: z.string().regex(/^[A-Z0-9]{10}$/i).describe("10-character Amazon ASIN, e.g. B08N5WRWNW"),
      marketplace: marketplaceSchema,
    },
  },
  async ({ asin, marketplace }) => {
    const code = mp(marketplace);
    const a = asin.toUpperCase();
    try {
      const key = `product:${code}:${a}`;
      const p = await getOrFetch(key, config.cacheTtlProduct, () => getProductDetails(a, code));
      if (p.price != null) logPrice(a, code, p.price);

      const feat = p.features.length ? `\n\nFeatures:\n${p.features.map((f) => `  • ${f}`).join("\n")}` : "";
      const crumbs = p.breadcrumbs.length ? `\nCategory: ${p.breadcrumbs.join(" › ")}` : "";
      const rating = p.rating != null ? `★${p.rating}${p.reviewCount != null ? ` (${p.reviewCount.toLocaleString()} ratings)` : ""}` : "No ratings";
      return text(
        `${p.title}\n` +
          `${money(p.price, p.currency)}  ${rating}  ${p.isPrime ? "✓Prime" : ""}\n` +
          `${p.brand ? `Brand: ${p.brand}\n` : ""}` +
          `${p.availability ? `Availability: ${p.availability}\n` : ""}` +
          `ASIN: ${p.asin} · Marketplace: ${code}${crumbs}\n` +
          `Buy (affiliate): ${p.affiliateUrl}` +
          feat,
      );
    } catch (e) {
      return errorText(`Could not fetch product ${a} on Amazon ${code}: ${(e as Error).message}`);
    }
  },
);

// ──────────────────────────────────────────────────────────── get_price_history
server.registerTool(
  "get_price_history",
  {
    title: "Get price history (Camelizer-style)",
    description:
      "Price history and buy/wait analysis for an ASIN. Builds a LOCAL price history over time: each lookup records the current price, then computes lowest/highest/average and a buy-wait verdict from your own tracked data. Also makes a best-effort attempt at CamelCamelCamel (frequently Cloudflare-blocked) and merges its data when available. The more you look up a product, the richer its trend.",
    inputSchema: {
      asin: z.string().regex(/^[A-Z0-9]{10}$/i).describe("10-character Amazon ASIN"),
      marketplace: marketplaceSchema,
    },
  },
  async ({ asin, marketplace }) => {
    const code = mp(marketplace);
    const a = asin.toUpperCase();
    let currency = MARKETPLACES[code].currency;

    // 1) Current price from the product page (works where Amazon isn't WAF-gated). Record it.
    let currentPrice: number | null = null;
    try {
      const prod = await getOrFetch(`product:${code}:${a}`, config.cacheTtlProduct, () => getProductDetails(a, code));
      currency = prod.currency || currency;
      if (prod.price != null) {
        currentPrice = prod.price;
        logPrice(a, code, prod.price);
      }
    } catch {
      /* product page blocked — fall back to whatever history exists */
    }

    // 2) Best-effort CamelCamelCamel (usually Cloudflare-blocked; treated as bonus data).
    let ccc: PriceHistory | null = null;
    try {
      ccc = await getOrFetch(`pricehist:${code}:${a}`, config.cacheTtlPriceHistory, () => getPriceHistory(a, code));
      if (ccc && ccc.current == null && ccc.lowest == null && ccc.highest == null) ccc = null;
    } catch {
      ccc = null;
    }

    // 3) Local history (source of truth here).
    const log = getPriceLog(a, code, 1000);
    const prices = log.map((p) => p.price);
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const localLowest = prices.length ? Math.min(...prices) : null;
    const localHighest = prices.length ? Math.max(...prices) : null;
    const localAvg = prices.length ? round2(prices.reduce((x, y) => x + y, 0) / prices.length) : null;

    // 4) Merge: prefer CCC where it has data, else local.
    const current = currentPrice ?? ccc?.current ?? log[0]?.price ?? null;
    const lowest = ccc?.lowest ?? localLowest;
    const highest = ccc?.highest ?? localHighest;
    const average = ccc?.average ?? localAvg;
    const source = ccc ? "camelcamelcamel + local" : "local price tracking";
    const dropFromHigh = current != null && highest != null && highest > 0 ? Math.round((1 - current / highest) * 1000) / 10 : null;

    let verdict: string;
    if (current == null) verdict = "Current price unknown (Amazon page blocked or unavailable).";
    else if (lowest != null && current <= lowest * 1.01) verdict = "At or near the lowest tracked price — great time to buy.";
    else if (average != null && current < average * 0.9) verdict = "Below average — good deal.";
    else if (average != null && current > average * 1.1) verdict = "Above average — consider waiting.";
    else if (average != null) verdict = "Around the average price.";
    else verdict = "Not enough history yet — look this product up a few more times to build a trend.";

    const drop = dropFromHigh != null ? `${dropFromHigh}% below tracked high` : "—";
    const recent = log.slice(0, 6);
    const recentStr = recent.length
      ? `\n\nTracked prices (${prices.length} point${prices.length === 1 ? "" : "s"}):\n${recent
          .map((p) => `  ${p.date.slice(0, 10)}: ${money(p.price, currency)}`)
          .join("\n")}`
      : "";

    return text(
      `Price history for ${a} (Amazon ${code}) — ${verdict}\n\n` +
        `Current: ${money(current, currency)}\n` +
        `Lowest:  ${money(lowest, currency)}\n` +
        `Highest: ${money(highest, currency)}\n` +
        `Average: ${money(average, currency)}\n` +
        `Drop:    ${drop}\n` +
        `Source:  ${source}` +
        recentStr,
    );
  },
);

// ────────────────────────────────────────────────────────────────── get_deals
server.registerTool(
  "get_deals",
  {
    title: "Get Amazon deals",
    description:
      "Find current discounted products on Amazon, optionally filtered by category keyword and minimum discount. Each deal includes an affiliate buy link.",
    inputSchema: {
      category: z.string().optional().describe("Category/keyword to filter deals, e.g. 'headphones'. Omit for general deals."),
      minDiscountPct: z.number().int().min(1).max(99).optional().describe("Only return deals with at least this % off"),
      marketplace: marketplaceSchema,
      limit: z.number().int().min(1).max(40).optional().describe("Max deals (default 20)"),
    },
  },
  async ({ category, minDiscountPct, marketplace, limit }) => {
    const code = mp(marketplace);
    try {
      const key = `deals:${code}:${category ?? "all"}:${minDiscountPct ?? 0}:${limit ?? 20}`;
      const deals = await getOrFetch(key, config.cacheTtlDeals, () =>
        getTodaysDeals(code, { category, minDiscountPct, limit: limit ?? 20 }),
      );
      if (deals.length === 0) return text(`No deals found on Amazon ${code}${category ? ` for "${category}"` : ""}.`);

      const lines = deals.map((d, i) => {
        const disc = d.discountPct != null ? ` (−${d.discountPct}%)` : "";
        const was = d.listPrice != null ? ` was ${money(d.listPrice, d.currency)}` : "";
        return `${i + 1}. ${d.title}\n   ${money(d.dealPrice, d.currency)}${disc}${was}\n   Buy (affiliate): ${d.affiliateUrl}`;
      });
      return text(`${deals.length} deals on Amazon ${code}${category ? ` for "${category}"` : ""}:\n\n${lines.join("\n\n")}`);
    } catch (e) {
      return errorText(`Could not fetch deals on Amazon ${code}: ${(e as Error).message}`);
    }
  },
);

// ───────────────────────────────────────────────────────────────── get_buy_link
server.registerTool(
  "get_buy_link",
  {
    title: "Get affiliate buy link",
    description:
      "Generate affiliate-tagged purchase links for an ASIN: a product page link and a one-click add-to-cart link. Opening either drops a 24h Amazon affiliate cookie so the configured Associates account earns commission on the purchase. Use this whenever the user wants to buy something.",
    inputSchema: {
      asin: z.string().regex(/^[A-Z0-9]{10}$/i).describe("10-character Amazon ASIN"),
      marketplace: marketplaceSchema,
      quantity: z.number().int().min(1).max(30).optional().describe("Quantity for the add-to-cart link (default 1)"),
    },
  },
  async ({ asin, marketplace, quantity }) => {
    const code = mp(marketplace);
    const a = asin.toUpperCase();
    const link = buildBuyLink(a, code, quantity ?? 1);
    return text(
      `Affiliate buy links for ${a} (Amazon ${code}):\n\n` +
        `Product page: ${link.productUrl}\n` +
        `Add to cart:  ${link.addToCartUrl}\n\n` +
        `Associate tag: ${link.associateTag}\n` +
        `${link.note}`,
    );
  },
);

// ─────────────────────────────────────────────────────── compare_marketplaces
server.registerTool(
  "compare_marketplaces",
  {
    title: "Compare an ASIN across marketplaces",
    description:
      "Look up the same ASIN across several Amazon marketplaces and compare prices side by side. Each row includes an affiliate buy link. Note: prices are in each marketplace's local currency and the same ASIN may not exist everywhere.",
    inputSchema: {
      asin: z.string().regex(/^[A-Z0-9]{10}$/i).describe("10-character Amazon ASIN"),
      marketplaces: z
        .array(z.enum(MARKETPLACE_CODES))
        .min(2)
        .max(8)
        .optional()
        .describe("Marketplaces to compare (default US, UK, DE, ES)"),
    },
  },
  async ({ asin, marketplaces }) => {
    const a = asin.toUpperCase();
    const codes = (marketplaces ?? (["US", "UK", "DE", "ES"] as MarketplaceCode[])).filter(
      (c, i, arr) => arr.indexOf(c) === i,
    );
    const settled = await Promise.allSettled(
      codes.map(async (c) => {
        const key = `product:${c}:${a}`;
        const p = await getOrFetch(key, config.cacheTtlProduct, () => getProductDetails(a, c));
        return { code: c, p };
      }),
    );

    const rows: string[] = [];
    settled.forEach((r, i) => {
      const c = codes[i];
      if (r.status === "fulfilled") {
        const { p } = r.value;
        rows.push(`${c}: ${money(p.price, p.currency)}  ${p.isPrime ? "✓Prime" : ""}\n   ${p.affiliateUrl}`);
      } else {
        rows.push(`${c}: not available (${(r.reason as Error)?.message ?? "lookup failed"})`);
      }
    });
    return text(`Price comparison for ${a}:\n\n${rows.join("\n\n")}`);
  },
);

// ──────────────────────────────────────────────────────────── add_price_watch
server.registerTool(
  "add_price_watch",
  {
    title: "Add a price-drop watch",
    description:
      "Track an ASIN and remember a target price. Use list_price_watches later to re-check; when the current price is at or below the target, the watch is flagged as triggered.",
    inputSchema: {
      asin: z.string().regex(/^[A-Z0-9]{10}$/i).describe("10-character Amazon ASIN"),
      targetPrice: z.number().positive().describe("Notify when price is at or below this value"),
      marketplace: marketplaceSchema,
    },
  },
  async ({ asin, targetPrice, marketplace }) => {
    const code = mp(marketplace);
    const w = addWatch(asin.toUpperCase(), code, targetPrice);
    return text(`Watching ${w.asin} on Amazon ${code} for a price ≤ ${money(w.targetPrice, MARKETPLACES[code].currency)} (watch #${w.id}).`);
  },
);

// ────────────────────────────────────────────────────────── list_price_watches
server.registerTool(
  "list_price_watches",
  {
    title: "List price watches (and re-check)",
    description:
      "List all saved price watches. When checkNow is true, re-fetches the current price for each watched ASIN, updates the stored last price, and reports which targets are met.",
    inputSchema: {
      checkNow: z.boolean().optional().describe("Re-fetch current prices and update watches (default false)"),
    },
  },
  async ({ checkNow }) => {
    const watches = listWatches();
    if (watches.length === 0) return text("No price watches saved. Use add_price_watch to create one.");

    const lines: string[] = [];
    for (const w of watches) {
      const cur = MARKETPLACES[w.marketplace].currency;
      let current = w.lastPrice;
      let hit = w.triggered;
      if (checkNow) {
        try {
          const p = await getProductDetails(w.asin, w.marketplace);
          if (p.price != null) {
            current = p.price;
            logPrice(w.asin, w.marketplace, p.price);
            updateWatchPrice(w.id, p.price);
            hit = p.price <= w.targetPrice;
          }
        } catch {
          /* leave last known */
        }
      }
      lines.push(
        `#${w.id} ${w.asin} (${w.marketplace}) target ≤ ${money(w.targetPrice, cur)} · now ${money(current, cur)} ${hit ? "✅ TARGET MET" : "⏳"}`,
      );
    }
    return text(`Price watches:\n\n${lines.join("\n")}`);
  },
);

// ───────────────────────────────────────────────────────── remove_price_watch
server.registerTool(
  "remove_price_watch",
  {
    title: "Remove a price watch",
    description: "Delete a saved price watch by its id (from list_price_watches).",
    inputSchema: {
      id: z.number().int().positive().describe("Watch id to remove"),
    },
  },
  async ({ id }) => {
    const ok = removeWatch(id);
    return text(ok ? `Removed watch #${id}.` : `No watch found with id #${id}.`);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for the JSON-RPC protocol.
  console.error(`amazon-mcp running (default marketplace: ${config.defaultMarketplace})`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

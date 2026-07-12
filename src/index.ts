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
      for (const rawLine of readFileSync(p, "utf8").split("\n")) {
        // Support an optional `export ` prefix, as real .env / shell files use.
        const m = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let val = m[2];
        const q = val[0];
        if ((q === '"' || q === "'") && val.length >= 2) {
          // Quoted value: take what's between the opening quote and its matching close,
          // ignoring anything after (e.g. a trailing `# comment`). A missing close quote
          // falls through to the unquoted path.
          const close = val.indexOf(q, 1);
          if (close > 0) {
            val = val.slice(1, close);
          } else {
            const hash = val.indexOf(" #");
            if (hash >= 0) val = val.slice(0, hash);
            val = val.trim();
          }
        } else {
          // Unquoted: strip a trailing inline comment ("TAG=abc-21 # note" -> "abc-21").
          const hash = val.indexOf(" #");
          if (hash >= 0) val = val.slice(0, hash);
          val = val.trim();
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
import { buildBuyLink, resolveAssociateTag, tagMatchesMarketplace } from "./lib/affiliate.js";
import { searchProducts, getProductDetails } from "./lib/amazon-scraper.js";
import { getPriceHistory } from "./lib/camelcamelcamel.js";
import { analyzePriceHistory } from "./lib/price-analysis.js";
import { getTodaysDeals } from "./lib/deals.js";
import {
  getOrFetch,
  isNonEmpty,
  logPrice,
  getPriceLog,
  addWatch,
  listWatches,
  removeWatch,
  updateWatchPrice,
  closeDb,
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

/** Currencies Amazon renders with no decimal places. */
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY"]);

function money(n: number | null, currency: string): string {
  if (n == null) return "—";
  const digits = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
}

/** Cap a scraped, seller-controlled string so it can't bloat or steer the LLM reply. */
function clip(s: string, max: number): string {
  const trimmed = s.trim();
  // Count by code points, not UTF-16 units, so we never slice through a surrogate pair
  // (emoji / astral chars) and emit a lone surrogate.
  const cps = Array.from(trimmed);
  return cps.length > max ? `${cps.slice(0, max - 1).join("")}…` : trimmed;
}

/**
 * One-line footer for tool outputs that embed affiliate links, warning when those
 * links won't actually earn commission (no/invalid tag, or a tag from another
 * marketplace's per-country program). Empty string when the tag is fine — the same
 * honesty get_buy_link already has, applied to every link-emitting tool.
 */
function affiliateNote(code: MarketplaceCode): string {
  const tag = resolveAssociateTag(code);
  if (!tag) {
    return `\n\nNote: links are untagged (no valid Associates tag configured for ${code}) — they work but earn no commission. Set AMAZON_ASSOCIATE_TAG_${code} or AMAZON_ASSOCIATE_TAG.`;
  }
  if (tagMatchesMarketplace(tag, code) === false) {
    return `\n\nNote: tag "${tag}" doesn't match Amazon ${code}'s Associates program (expected suffix -${MARKETPLACES[code].tagSuffix}) — these links likely earn NO commission on ${code}. Set AMAZON_ASSOCIATE_TAG_${code}.`;
  }
  return "";
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
    annotations: {"readOnlyHint": true, "openWorldHint": true},
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
      const key = `search:${code}:${limit ?? 16}:${query.trim().toLowerCase().replace(/\s+/g, " ")}`;
      const results = await getOrFetch(
        key,
        config.cacheTtlProduct,
        () => searchProducts(query, code, limit ?? 16),
        isNonEmpty,
      );
      if (results.length === 0) return text(`No results for "${query}" on Amazon ${code}.`);

      const lines = results.map((p, i) => {
        const rating = p.rating != null ? `★${p.rating}${p.reviewCount != null ? ` (${p.reviewCount.toLocaleString()})` : ""}` : "";
        return `${i + 1}. ${clip(p.title, 180)}\n   ${money(p.price, p.currency)}  ${rating}  ${p.isPrime ? "✓Prime" : ""}\n   ASIN: ${p.asin}\n   Buy (affiliate): ${p.affiliateUrl}`;
      });
      return text(`Top ${results.length} results for "${query}" on Amazon ${code}:\n\n${lines.join("\n\n")}` + affiliateNote(code));
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
    // Not read-only: it records the fetched price into the local price-history log.
    annotations: {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": true},
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

      const feat = p.features.length
        ? `\n\nFeatures:\n${p.features.slice(0, 10).map((f) => `  • ${clip(f, 200)}`).join("\n")}`
        : "";
      const crumbs = p.breadcrumbs.length ? `\nCategory: ${p.breadcrumbs.slice(0, 8).map((c) => clip(c, 60)).join(" › ")}` : "";
      const rating = p.rating != null ? `★${p.rating}${p.reviewCount != null ? ` (${p.reviewCount.toLocaleString()} ratings)` : ""}` : "No ratings";
      return text(
        `${clip(p.title, 200)}\n` +
          `${money(p.price, p.currency)}  ${rating}  ${p.isPrime ? "✓Prime" : ""}\n` +
          `${p.brand ? `Brand: ${clip(p.brand, 80)}\n` : ""}` +
          `${p.availability ? `Availability: ${clip(p.availability, 120)}\n` : ""}` +
          `ASIN: ${p.asin} · Marketplace: ${code}${crumbs}\n` +
          `Buy (affiliate): ${p.affiliateUrl}` +
          feat +
          affiliateNote(code),
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
    // Not read-only: each lookup records the current price into the local history log.
    annotations: {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": true},
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

    // 2) Best-effort CamelCamelCamel (usually Cloudflare-blocked; treated as bonus
    // data). A degraded all-null result is a FAILURE, not data — don't cache it for
    // 6h as if it were a success; let the next call retry.
    let ccc: PriceHistory | null = null;
    try {
      ccc = await getOrFetch(
        `pricehist:${code}:${a}`,
        config.cacheTtlPriceHistory,
        () => getPriceHistory(a, code),
        (h) => h.current != null || h.lowest != null || h.highest != null,
      );
      if (ccc && ccc.current == null && ccc.lowest == null && ccc.highest == null) ccc = null;
    } catch {
      ccc = null;
    }

    // 3) Local history + merge + verdict (pure logic in lib/price-analysis.ts).
    const log = getPriceLog(a, code, 1000);
    const analysis = analyzePriceHistory({
      livePrice: currentPrice,
      ccc,
      log,
      formatMoney: (n) => money(n, currency),
    });
    const { current, currentAsOf, lowest, highest, average, dropFromHighPct, verdict, source } = analysis;

    const drop = dropFromHighPct != null ? `${dropFromHighPct}% below tracked high` : "\u2014";
    const recent = log.slice(0, 6);
    const recentStr = recent.length
      ? `\n\nTracked prices (${log.length} point${log.length === 1 ? "" : "s"}):\n${recent
          .map((p) => `  ${p.date.slice(0, 10)}: ${money(p.price, currency)}`)
          .join("\n")}`
      : "";

    const chartStr = ccc?.chartUrl ? `\nChart:   ${ccc.chartUrl}` : "";
    // When "current" is really "last seen" (both Amazon and CCC unavailable), say so.
    const currentLabel = currentAsOf ? `${money(current, currency)} (last seen ${currentAsOf})` : money(current, currency);

    return text(
      `Price history for ${a} (Amazon ${code}) — ${verdict}\n\n` +
        `Current: ${currentLabel}\n` +
        `Lowest:  ${money(lowest, currency)}\n` +
        `Highest: ${money(highest, currency)}\n` +
        `Average: ${money(average, currency)}\n` +
        `Drop:    ${drop}\n` +
        `Source:  ${source}` +
        chartStr +
        recentStr,
    );
  },
);

// ────────────────────────────────────────────────────────────────── get_deals
server.registerTool(
  "get_deals",
  {
    title: "Get Amazon deals",
    annotations: {"readOnlyHint": true, "openWorldHint": true},
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
      const key = `deals:${code}:${category ? category.trim().toLowerCase() : "\u0000none"}:${minDiscountPct ?? 0}:${limit ?? 20}`;
      const deals = await getOrFetch(
        key,
        config.cacheTtlDeals,
        () => getTodaysDeals(code, { category, minDiscountPct, limit: limit ?? 20 }),
        isNonEmpty,
      );
      if (deals.length === 0) return text(`No deals found on Amazon ${code}${category ? ` for "${category}"` : ""}.`);

      const lines = deals.map((d, i) => {
        const disc = d.discountPct != null ? ` (−${d.discountPct}%)` : "";
        const was = d.listPrice != null ? ` was ${money(d.listPrice, d.currency)}` : "";
        return `${i + 1}. ${clip(d.title, 180)}\n   ${money(d.dealPrice, d.currency)}${disc}${was}\n   Buy (affiliate): ${d.affiliateUrl}`;
      });
      return text(`${deals.length} deals on Amazon ${code}${category ? ` for "${category}"` : ""}:\n\n${lines.join("\n\n")}` + affiliateNote(code));
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
    annotations: {"readOnlyHint": true, "openWorldHint": false},
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
        `Associate tag: ${link.associateTag ?? "(none configured)"}\n` +
        `${link.note}`,
    );
  },
);

// ─────────────────────────────────────────────────────── compare_marketplaces
server.registerTool(
  "compare_marketplaces",
  {
    title: "Compare an ASIN across marketplaces",
    annotations: {"readOnlyHint": true, "openWorldHint": true},
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
    const notes = [...new Set(codes.map((c) => affiliateNote(c)).filter(Boolean))].join("");
    return text(`Price comparison for ${a}:\n\n${rows.join("\n\n")}` + notes);
  },
);

// ──────────────────────────────────────────────────────────── add_price_watch
server.registerTool(
  "add_price_watch",
  {
    title: "Add a price-drop watch",
    annotations: {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
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
    annotations: {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": true},
    description:
      "List all saved price watches. When checkNow is true, re-fetches the current price for each watched ASIN, updates the stored last price, and reports which targets are met.",
    inputSchema: {
      checkNow: z.boolean().optional().describe("Re-fetch current prices and update watches (default false)"),
    },
  },
  async ({ checkNow }) => {
    const watches = listWatches();
    if (watches.length === 0) return text("No price watches saved. Use add_price_watch to create one.");

    // When re-checking, fetch all watched products concurrently (bounded) so N watches
    // don't take N × the single-lookup latency. Track failures per watch — a blocked
    // re-check must be visible, not silently rendered as a fresh "now" price.
    const refreshed = new Map<number, number>();
    const failed = new Set<number>();
    if (checkNow) {
      const CONCURRENCY = 4;
      for (let i = 0; i < watches.length; i += CONCURRENCY) {
        const batch = watches.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          batch.map(async (w) => {
            try {
              const p = await getProductDetails(w.asin, w.marketplace);
              if (p.price != null) {
                logPrice(w.asin, w.marketplace, p.price);
                updateWatchPrice(w.id, p.price);
                refreshed.set(w.id, p.price);
              } else {
                failed.add(w.id);
              }
            } catch {
              failed.add(w.id);
            }
          }),
        );
      }
    }

    const lines = watches.map((w) => {
      const cur = MARKETPLACES[w.marketplace].currency;
      const current = refreshed.has(w.id) ? refreshed.get(w.id)! : w.lastPrice;
      // Derive "target met" from the actual current price, never a stale latched flag.
      const hit = current != null && current <= w.targetPrice;
      const stale = failed.has(w.id) ? " (re-check failed — showing last known price)" : "";
      return `#${w.id} ${w.asin} (${w.marketplace}) target ≤ ${money(w.targetPrice, cur)} · now ${money(current, cur)} ${hit ? "✅ TARGET MET" : "⏳"}${stale}`;
    });
    const failNote =
      checkNow && failed.size > 0 ? `\n\n⚠ ${failed.size} of ${watches.length} re-checks failed (Amazon blocked or product unavailable).` : "";
    return text(`Price watches:\n\n${lines.join("\n")}${failNote}`);
  },
);

// ───────────────────────────────────────────────────────── remove_price_watch
server.registerTool(
  "remove_price_watch",
  {
    title: "Remove a price watch",
    annotations: {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false},
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

  // Flush the SQLite WAL and close cleanly on shutdown.
  const shutdown = () => {
    try {
      closeDb();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

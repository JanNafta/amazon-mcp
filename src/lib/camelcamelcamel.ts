import * as cheerio from "cheerio";

import { MARKETPLACES } from "../config.js";
import type { MarketplaceCode, PriceHistory } from "../types.js";
import { fetchHtml, parsePrice } from "./http.js";

/**
 * CamelCamelCamel (CCC) price-history scraper.
 *
 * CCC tracks Amazon price history per marketplace on country subdomains. It is
 * aggressive about Cloudflare challenges and changes its HTML occasionally, so
 * every step degrades gracefully: we always return a well-formed PriceHistory,
 * never throw, and keep the chart image URL (which usually keeps working even
 * when the HTML is blocked).
 */

/** Amazon marketplace code -> CCC subdomain host. */
const CCC_HOSTS: Partial<Record<MarketplaceCode, string>> = {
  US: "camelcamelcamel.com",
  UK: "uk.camelcamelcamel.com",
  DE: "de.camelcamelcamel.com",
  FR: "fr.camelcamelcamel.com",
  IT: "it.camelcamelcamel.com",
  ES: "es.camelcamelcamel.com",
  CA: "camelcamelcamel.com",
  JP: "jp.camelcamelcamel.com",
};

/** Amazon marketplace code -> CCC country code used in the charts host. */
const CCC_COUNTRY: Partial<Record<MarketplaceCode, string>> = {
  US: "us",
  UK: "uk",
  DE: "de",
  FR: "fr",
  IT: "it",
  ES: "es",
  JP: "jp",
  CA: "us",
};

interface ParsedRow {
  current: number | null;
  lowest: number | null;
  lowestDate: string | null;
  highest: number | null;
  highestDate: string | null;
  average: number | null;
}

/** Build the CCC chart image URL for a supported marketplace. */
function buildChartUrl(asin: string, code: MarketplaceCode): string | null {
  const country = CCC_COUNTRY[code];
  if (!country) return null;
  return (
    `https://charts.camelcamelcamel.com/${country}/${asin}/amazon.png` +
    `?force=1&zero=0&w=725&h=440&desired=false&legend=1&ilt=1&tp=all&fo=0&lang=en`
  );
}

/** Normalize a raw date string ("Dec 24, 2024") to an ISO date; null if unparseable. */
function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    // Keep the raw string if it looks date-like, otherwise drop it.
    return /\d/.test(trimmed) ? trimmed : null;
  }
  return d.toISOString().slice(0, 10);
}

/** True when a table cell's text carries a price (currency symbol or digits). */
function looksLikePrice(text: string): boolean {
  return /[\d$£€¥]/.test(text);
}

/**
 * Walk every table row and classify it by its label cell. CCC lays out a
 * "Price | Date" table whose first column holds labels like "Amazon", "Lowest
 * Price", "Highest Price", "Average". We read each row's cells, find the price
 * cell and (where relevant) the date cell.
 */
function parsePriceTable($: cheerio.CheerioAPI): ParsedRow {
  const result: ParsedRow = {
    current: null,
    lowest: null,
    lowestDate: null,
    highest: null,
    highestDate: null,
    average: null,
  };

  let sawCurrent = false;

  $("table tr").each((_i, tr) => {
    const cells = $(tr).find("td, th").toArray();
    if (cells.length === 0) return;

    const cellTexts = cells.map((c) => $(c).text().replace(/\s+/g, " ").trim());
    const label = (cellTexts[0] ?? "").toLowerCase();
    if (!label) return;

    // Price cell: prefer a cell that looks like a price (skip the label cell).
    const priceCell = cellTexts.slice(1).find((t) => looksLikePrice(t)) ?? null;
    const price = priceCell ? parsePrice(priceCell) : null;

    // Date cell: a later cell that does not itself look like a price.
    const dateCell =
      cellTexts.slice(1).find((t) => t.length > 0 && !looksLikePrice(t)) ?? null;
    const date = normalizeDate(dateCell);

    if ((label.includes("current") || label.includes("amazon")) && !sawCurrent) {
      // Only the first "current"/"amazon" row sets the current price.
      if (price !== null) {
        result.current = price;
        sawCurrent = true;
      }
    } else if (label.includes("lowest")) {
      if (price !== null && result.lowest === null) result.lowest = price;
      if (date && result.lowestDate === null) result.lowestDate = date;
    } else if (label.includes("highest")) {
      if (price !== null && result.highest === null) result.highest = price;
      if (date && result.highestDate === null) result.highestDate = date;
    } else if (label.includes("average")) {
      if (price !== null && result.average === null) result.average = price;
    }
  });

  return result;
}

/** Compute the Camelizer-style human verdict from the parsed numbers. */
function buildVerdict(parsed: ParsedRow): string {
  const { current, lowest, average } = parsed;
  if (current === null) return "Current price unknown";
  if (lowest !== null && current <= lowest * 1.01) {
    return "At or near the lowest price ever — great time to buy";
  }
  if (average !== null && current < average * 0.9) return "Below average — good deal";
  if (average !== null && current > average * 1.1) return "Above average — consider waiting";
  return "Around the average price";
}

/** Percentage the current price sits below the all-time high (positive = discounted). */
function computeDropFromHigh(current: number | null, highest: number | null): number | null {
  if (current === null || highest === null || highest <= 0) return null;
  return Math.round((1 - current / highest) * 1000) / 10;
}

/**
 * Fetch and parse the CamelCamelCamel price history for an ASIN in a given
 * marketplace. Always resolves to a PriceHistory; failures degrade to a
 * null-filled object with an explanatory verdict.
 */
export async function getPriceHistory(
  asin: string,
  code: MarketplaceCode,
): Promise<PriceHistory> {
  const currency = MARKETPLACES[code].currency;
  const host = CCC_HOSTS[code];

  // Unsupported marketplace: CCC has no data here.
  if (!host) {
    return {
      asin,
      marketplace: code,
      currency,
      current: null,
      lowest: null,
      lowestDate: null,
      highest: null,
      highestDate: null,
      average: null,
      dropFromHighPct: null,
      verdict: "Price history not available for this marketplace",
      source: "camelcamelcamel",
      chartUrl: null,
    };
  }

  const chartUrl = buildChartUrl(asin, code);
  const url = `https://${host}/product/${asin}`;

  let html: string;
  try {
    html = await fetchHtml(url, { acceptLanguage: "en-US,en;q=0.9", retries: 2 });
  } catch {
    // Network/blocking failure: the page never loaded, but the chart often does.
    return {
      asin,
      marketplace: code,
      currency,
      current: null,
      lowest: null,
      lowestDate: null,
      highest: null,
      highestDate: null,
      average: null,
      dropFromHighPct: null,
      verdict: "Price history temporarily unavailable",
      source: "camelcamelcamel",
      chartUrl,
    };
  }

  try {
    const $ = cheerio.load(html);
    const parsed = parsePriceTable($);
    const dropFromHighPct = computeDropFromHigh(parsed.current, parsed.highest);
    const verdict = buildVerdict(parsed);

    return {
      asin,
      marketplace: code,
      currency,
      current: parsed.current,
      lowest: parsed.lowest,
      lowestDate: parsed.lowestDate,
      highest: parsed.highest,
      highestDate: parsed.highestDate,
      average: parsed.average,
      dropFromHighPct,
      verdict,
      source: "camelcamelcamel",
      chartUrl,
    };
  } catch {
    // Page loaded but layout changed / Cloudflare challenge body: keep the chart.
    return {
      asin,
      marketplace: code,
      currency,
      current: null,
      lowest: null,
      lowestDate: null,
      highest: null,
      highestDate: null,
      average: null,
      dropFromHighPct: null,
      verdict: "Could not parse price history (page layout changed or blocked)",
      source: "camelcamelcamel",
      chartUrl,
    };
  }
}

import type { Marketplace, MarketplaceCode } from "./types.js";

export const MARKETPLACES: Record<MarketplaceCode, Marketplace> = {
  US: { code: "US", tld: "com", host: "www.amazon.com", acceptLanguage: "en-US,en;q=0.9", currency: "USD", tagSuffix: "20" },
  ES: { code: "ES", tld: "es", host: "www.amazon.es", acceptLanguage: "es-ES,es;q=0.9", currency: "EUR", tagSuffix: "21" },
  UK: { code: "UK", tld: "co.uk", host: "www.amazon.co.uk", acceptLanguage: "en-GB,en;q=0.9", currency: "GBP", tagSuffix: "21" },
  DE: { code: "DE", tld: "de", host: "www.amazon.de", acceptLanguage: "de-DE,de;q=0.9", currency: "EUR", tagSuffix: "21" },
  FR: { code: "FR", tld: "fr", host: "www.amazon.fr", acceptLanguage: "fr-FR,fr;q=0.9", currency: "EUR", tagSuffix: "21" },
  IT: { code: "IT", tld: "it", host: "www.amazon.it", acceptLanguage: "it-IT,it;q=0.9", currency: "EUR", tagSuffix: "21" },
  CA: { code: "CA", tld: "ca", host: "www.amazon.ca", acceptLanguage: "en-CA,en;q=0.9", currency: "CAD", tagSuffix: "20" },
  JP: { code: "JP", tld: "co.jp", host: "www.amazon.co.jp", acceptLanguage: "ja-JP,ja;q=0.9", currency: "JPY", tagSuffix: "22" },
  MX: { code: "MX", tld: "com.mx", host: "www.amazon.com.mx", acceptLanguage: "es-MX,es;q=0.9", currency: "MXN", tagSuffix: "20" },
  IN: { code: "IN", tld: "in", host: "www.amazon.in", acceptLanguage: "en-IN,en;q=0.9", currency: "INR", tagSuffix: "21" },
  BR: { code: "BR", tld: "com.br", host: "www.amazon.com.br", acceptLanguage: "pt-BR,pt;q=0.9", currency: "BRL", tagSuffix: "20" },
  AU: { code: "AU", tld: "com.au", host: "www.amazon.com.au", acceptLanguage: "en-AU,en;q=0.9", currency: "AUD", tagSuffix: "22" },
};

/** Placeholder tag used when the user has not configured a real Associates tag. */
export const PLACEHOLDER_TAG = "amazonmcp00-20";

export function resolveMarketplace(code?: string): Marketplace {
  const fallback = (process.env.AMAZON_DEFAULT_MARKETPLACE || "US").toUpperCase();
  const key = (code || fallback).toUpperCase() as MarketplaceCode;
  return MARKETPLACES[key] ?? MARKETPLACES.US;
}

export interface Config {
  defaultMarketplace: MarketplaceCode;
  cacheTtlProduct: number;
  cacheTtlPriceHistory: number;
  cacheTtlDeals: number;
  cacheDbPath: string;
}

export function loadConfig(): Config {
  const defaultMarketplace = (process.env.AMAZON_DEFAULT_MARKETPLACE || "US").toUpperCase() as MarketplaceCode;
  return {
    defaultMarketplace: MARKETPLACES[defaultMarketplace] ? defaultMarketplace : "US",
    cacheTtlProduct: Number(process.env.AMAZON_CACHE_TTL_PRODUCT) || 3600,
    cacheTtlPriceHistory: Number(process.env.AMAZON_CACHE_TTL_PRICE_HISTORY) || 21600,
    cacheTtlDeals: Number(process.env.AMAZON_CACHE_TTL_DEALS) || 900,
    cacheDbPath: process.env.AMAZON_CACHE_DB_PATH || "",
  };
}

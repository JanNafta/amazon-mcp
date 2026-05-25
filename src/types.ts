// Shared types across the Amazon MCP server.

export type MarketplaceCode =
  | "US"
  | "ES"
  | "UK"
  | "DE"
  | "FR"
  | "IT"
  | "CA"
  | "JP"
  | "MX"
  | "IN"
  | "BR"
  | "AU";

export interface Marketplace {
  code: MarketplaceCode;
  /** Top-level domain, e.g. "com", "es", "co.uk". */
  tld: string;
  host: string;
  /** Accept-Language header value for realistic requests. */
  acceptLanguage: string;
  currency: string;
  /** Suffix Amazon appends to associate tags for this marketplace, e.g. "20" for US. */
  tagSuffix: string;
}

export interface ProductSummary {
  asin: string;
  title: string;
  url: string;
  /** Affiliate URL with the configured tag injected. */
  affiliateUrl: string;
  price: number | null;
  currency: string;
  rating: number | null;
  reviewCount: number | null;
  imageUrl: string | null;
  isPrime: boolean;
  marketplace: MarketplaceCode;
}

export interface ProductDetails extends ProductSummary {
  features: string[];
  availability: string | null;
  brand: string | null;
  /** byline / "Visit the X Store" text when present. */
  byline: string | null;
  breadcrumbs: string[];
}

export interface PricePoint {
  date: string; // ISO date
  price: number;
}

export interface PriceHistory {
  asin: string;
  marketplace: MarketplaceCode;
  currency: string;
  current: number | null;
  lowest: number | null;
  lowestDate: string | null;
  highest: number | null;
  highestDate: string | null;
  average: number | null;
  /** Percentage below the all-time high (positive = currently discounted). */
  dropFromHighPct: number | null;
  /** Human verdict, Camelizer style: "At lowest price ever", "Good deal", etc. */
  verdict: string;
  source: "camelcamelcamel" | "local";
  chartUrl: string | null;
}

export interface Deal {
  asin: string | null;
  title: string;
  url: string;
  affiliateUrl: string;
  dealPrice: number | null;
  listPrice: number | null;
  discountPct: number | null;
  currency: string;
  imageUrl: string | null;
  expiresAt: string | null;
  marketplace: MarketplaceCode;
}

export interface BuyLink {
  asin: string;
  marketplace: MarketplaceCode;
  /** Product detail page with affiliate tag. */
  productUrl: string;
  /** One-click add-to-cart URL with affiliate tag. */
  addToCartUrl: string;
  associateTag: string | null;
  /** True when a real associate tag was applied (i.e. the link earns commission). */
  tagged: boolean;
  note: string;
}

export interface PriceWatch {
  id: number;
  asin: string;
  marketplace: MarketplaceCode;
  targetPrice: number;
  lastPrice: number | null;
  createdAt: string;
  triggered: boolean;
}

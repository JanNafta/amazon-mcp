import axios, { type AxiosRequestConfig } from "axios";

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
];

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export interface FetchOptions {
  acceptLanguage?: string;
  /** Number of retry attempts on transient failures. Default 3. */
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a URL with browser-like headers, UA rotation and exponential backoff.
 * Amazon and CamelCamelCamel block obvious bots, so we mimic a real browser.
 */
export async function fetchHtml(url: string, opts: FetchOptions = {}): Promise<string> {
  const { acceptLanguage = "en-US,en;q=0.9", retries = 3, timeoutMs = 15000, headers = {} } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const config: AxiosRequestConfig = {
        timeout: timeoutMs,
        maxRedirects: 5,
        responseType: "text",
        // Accept any 2xx-4xx so we can inspect blocked/captcha pages instead of throwing.
        validateStatus: (s) => s < 500,
        headers: {
          "User-Agent": pickUserAgent(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": acceptLanguage,
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Upgrade-Insecure-Requests": "1",
          ...headers,
        },
      };

      const res = await axios.get<string>(url, config);
      const body = res.data ?? "";

      if (res.status === 429 || res.status === 503) {
        throw new Error(`Rate limited (HTTP ${res.status})`);
      }
      if (typeof body === "string" && /To discuss automated access|Type the characters you see in this image|api-services-support@amazon\.com/i.test(body)) {
        throw new Error("Blocked by Amazon bot detection (CAPTCHA page)");
      }
      return body;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const backoff = 800 * Math.pow(2, attempt) + Math.random() * 400;
        await sleep(backoff);
      }
    }
  }
  throw new Error(`fetchHtml failed for ${url}: ${(lastErr as Error)?.message ?? lastErr}`);
}

/** Parse a localized price string into a number. Handles "1.234,56 €", "$1,234.56", "£12.99", "12,99". */
export function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,]/g, "").trim();
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized: string;

  if (lastComma > lastDot) {
    // Comma is the decimal separator (EU): 1.234,56 -> 1234.56
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    // Dot is the decimal separator (US): 1,234.56 -> 1234.56
    normalized = cleaned.replace(/,/g, "");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }

  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Extract a 10-char ASIN from a URL or string. */
export function extractAsin(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = input.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})/i) || input.match(/\b([A-Z0-9]{10})\b/i);
  return m ? m[1].toUpperCase() : null;
}

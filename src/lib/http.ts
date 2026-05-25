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

const CAPTCHA_RE =
  /To discuss automated access|Type the characters you see in this image|api-services-support@amazon\.com|Enter the characters you see below/i;

/** Cloudflare's "Just a moment..." JS interstitial (used by e.g. camelcamelcamel.com). */
const CLOUDFLARE_RE =
  /Just a moment\.\.\.|cf-browser-verification|Checking if the site connection is secure|challenge-platform|cf_chl_|window\._cf_chl_opt/i;

/**
 * Amazon/Akamai bot-manager interstitials are tiny HTML stubs that meta-refresh to a URL
 * carrying a `bm-verify` token. Extract that target so we can follow it like a browser would.
 */
function extractMetaRefresh(html: string, baseUrl: string): string | null {
  if (html.length > 20000) return null; // real result pages aren't tiny refresh stubs
  const m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d+\s*;\s*url=['"]?([^'">\s]+)/i);
  if (!m) return null;
  try {
    return new URL(m[1].replace(/&amp;/g, "&"), baseUrl).toString();
  } catch {
    return null;
  }
}

/** A still-unresolved challenge page after we've exhausted our hops. */
function isChallengeStub(html: string): boolean {
  return html.length < 20000 && /bm-verify|http-equiv=["']?refresh/i.test(html);
}

/**
 * AWS WAF Captcha/Challenge JS SDK page. Resolving it needs a real JS engine
 * (proof-of-work for the aws-waf-token cookie), so plain HTTP cannot get past it.
 */
function isWafChallenge(html: string): boolean {
  return html.length < 20000 && /awsWafCookieDomainList|gokuProps|aws-waf-token|captcha\.awswaf|AwsWafIntegration/i.test(html);
}

/** Accumulate Set-Cookie values into a Cookie header string across challenge hops. */
function mergeCookies(prev: string, setCookie: string[] | undefined): string {
  if (!setCookie || setCookie.length === 0) return prev;
  const jar = new Map<string, string>();
  for (const c of prev.split("; ").filter(Boolean)) {
    const eq = c.indexOf("=");
    if (eq > 0) jar.set(c.slice(0, eq), c.slice(eq + 1));
  }
  for (const sc of setCookie) {
    const first = sc.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * GET a URL with browser-like headers, UA rotation and exponential backoff.
 * Amazon and CamelCamelCamel block obvious bots, so we mimic a real browser and
 * transparently follow up to 2 bot-manager meta-refresh challenge hops, carrying
 * the bm-verify token and any Set-Cookie values forward (as a real browser does).
 */
export async function fetchHtml(url: string, opts: FetchOptions = {}): Promise<string> {
  const { acceptLanguage = "en-US,en;q=0.9", retries = 3, timeoutMs = 15000, headers = {} } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ua = pickUserAgent(); // keep a stable UA across hops within one attempt
    let cookies = "";
    try {
      let currentUrl = url;
      let body = "";

      for (let hop = 0; hop <= 2; hop++) {
        const config: AxiosRequestConfig = {
          timeout: timeoutMs,
          maxRedirects: 5,
          responseType: "text",
          // Accept any 2xx-4xx so we can inspect blocked/captcha pages instead of throwing.
          validateStatus: (s) => s < 500,
          headers: {
            "User-Agent": ua,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": acceptLanguage,
            "Accept-Encoding": "gzip, deflate, br",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": hop === 0 ? "none" : "same-origin",
            "Upgrade-Insecure-Requests": "1",
            ...(cookies ? { Cookie: cookies } : {}),
            ...headers,
          },
        };

        const res = await axios.get<string>(currentUrl, config);
        body = res.data ?? "";
        cookies = mergeCookies(cookies, res.headers?.["set-cookie"] as string[] | undefined);

        if (res.status === 429 || res.status === 503) {
          throw new Error(`Rate limited (HTTP ${res.status})`);
        }
        if (typeof body === "string" && CAPTCHA_RE.test(body)) {
          throw new Error("Blocked by Amazon bot detection (CAPTCHA page)");
        }
        if (typeof body === "string" && isWafChallenge(body)) {
          throw new Error("Blocked by AWS WAF JS challenge (this marketplace requires a headless browser)");
        }
        if (typeof body === "string" && body.length < 20000 && CLOUDFLARE_RE.test(body)) {
          throw new Error("Blocked by Cloudflare challenge (source requires a headless browser)");
        }

        const next = extractMetaRefresh(body, currentUrl);
        if (next && hop < 2) {
          await sleep(1200 + Math.random() * 800);
          currentUrl = next;
          continue;
        }
        break;
      }

      if (isChallengeStub(body)) {
        throw new Error("Blocked by Amazon bot-manager challenge (bm-verify interstitial)");
      }
      return body;
    } catch (err) {
      lastErr = err;
      // CAPTCHA / WAF / Cloudflare challenges won't resolve by retrying — fail fast.
      if (/Blocked by (Amazon bot detection|AWS WAF|Cloudflare)/.test((err as Error)?.message ?? "")) break;
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

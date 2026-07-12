import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock only axios — fetchHtml's whole behavior (retries, challenge detection,
// meta-refresh hops, cookie handling) then runs against scripted HTTP responses.
vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

import axios from "axios";
import { fetchHtml } from "../src/lib/http.js";

const get = vi.mocked(axios.get);

interface MockResponse {
  status?: number;
  data?: string;
  headers?: Record<string, unknown>;
}

function resp(r: MockResponse) {
  return { status: r.status ?? 200, data: r.data ?? "", headers: r.headers ?? {} };
}

/** A body long enough (>20k) to not be treated as a tiny challenge stub. */
const BIG_OK = `<html><body>${"x".repeat(21000)}</body></html>`;

beforeEach(() => {
  get.mockReset();
});

describe("fetchHtml — challenge detection fails fast (no useless retries)", () => {
  it("throws on an Amazon CAPTCHA page without retrying", async () => {
    get.mockResolvedValue(resp({ data: "Type the characters you see in this image" }));

    await expect(fetchHtml("https://www.amazon.com/dp/X", { retries: 3 })).rejects.toThrow(/CAPTCHA/);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("throws on an AWS WAF JS challenge without retrying", async () => {
    get.mockResolvedValue(resp({ data: '<script>window.gokuProps = {"key":"x"}</script>' }));

    await expect(fetchHtml("https://www.amazon.co.uk/s?k=x", { retries: 3 })).rejects.toThrow(/AWS WAF/);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("throws on a Cloudflare interstitial without retrying", async () => {
    get.mockResolvedValue(resp({ data: "<title>Just a moment...</title>" }));

    await expect(fetchHtml("https://camelcamelcamel.com/product/X", { retries: 3 })).rejects.toThrow(/Cloudflare/);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("fetchHtml — retry on transient failures", () => {
  it("retries a 429 and succeeds on the second attempt", async () => {
    get
      .mockResolvedValueOnce(resp({ status: 429, data: "slow down" }))
      .mockResolvedValueOnce(resp({ data: BIG_OK }));

    const body = await fetchHtml("https://www.amazon.com/dp/X", { retries: 1 });
    expect(body).toBe(BIG_OK);
    expect(get).toHaveBeenCalledTimes(2);
  }, 15000);

  it("gives up after exhausting retries and surfaces the last error", async () => {
    get.mockResolvedValue(resp({ status: 503, data: "" }));

    await expect(fetchHtml("https://www.amazon.com/dp/X", { retries: 0 })).rejects.toThrow(/HTTP 503/);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("fetchHtml — meta-refresh challenge hops (bot-manager)", () => {
  const refreshStub = (target: string) =>
    `<html><head><meta http-equiv="refresh" content="0;url=${target}"></head></html>`;

  it("follows a SAME-ORIGIN meta-refresh and returns the final page", async () => {
    get
      .mockResolvedValueOnce(resp({ data: refreshStub("https://www.amazon.com/x?bm-verify=tok") }))
      .mockResolvedValueOnce(resp({ data: BIG_OK }));

    const body = await fetchHtml("https://www.amazon.com/dp/X", { retries: 0 });
    expect(body).toBe(BIG_OK);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][0]).toBe("https://www.amazon.com/x?bm-verify=tok");
  }, 15000);

  it("does NOT follow a meta-refresh to a different host (SSRF guard)", async () => {
    get.mockResolvedValue(resp({ data: refreshStub("https://evil.example.com/steal") }));

    // The stub still looks like an unresolved challenge, so fetchHtml throws — but it
    // must never have requested the foreign host.
    await expect(fetchHtml("https://www.amazon.com/dp/X", { retries: 0 })).rejects.toThrow();
    for (const call of get.mock.calls) {
      expect(String(call[0])).not.toContain("evil.example.com");
    }
  });

  it("carries origin cookies across a same-origin hop, and only to the origin", async () => {
    get
      .mockResolvedValueOnce(
        resp({
          data: refreshStub("https://www.amazon.com/challenge?bm-verify=tok"),
          headers: { "set-cookie": ["session-id=SECRET; Path=/", "bm=1; Path=/"] },
        }),
      )
      .mockResolvedValueOnce(resp({ data: BIG_OK }));

    await fetchHtml("https://www.amazon.com/dp/X", { retries: 0 });

    const secondConfig = get.mock.calls[1][1] as { headers: Record<string, string> };
    expect(secondConfig.headers.Cookie).toContain("session-id=SECRET");
    expect(secondConfig.headers.Cookie).toContain("bm=1");
  }, 15000);
});

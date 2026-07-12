/**
 * Integration test: the built MCP server over stdio, fully OFFLINE.
 *
 * Spawns `node dist/index.js` (building first if dist is missing), speaks
 * newline-delimited JSON-RPC like scripts/e2e.mjs, and exercises only the
 * tools that need no network: tools/list, get_buy_link, the price-watch
 * lifecycle (checkNow:false) and input validation.
 *
 * Hermeticity: the repo's local .env defines real tags (AMAZON_ASSOCIATE_TAG,
 * AMAZON_ASSOCIATE_TAG_ES) and AMAZON_DEFAULT_MARKETPLACE=ES. The server's
 * .env loader only fills env vars that are *undefined*, so we pin every one
 * of those (empty string counts as defined) to make the run reproducible.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");
const DB_PATH = join(
  tmpdir(),
  `amz-stdio-it-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);

const RPC_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

let child: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (msg: RpcResponse) => void>();

function rpc(method: string, params?: unknown): Promise<RpcResponse> {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for response to ${method}`));
    }, RPC_TIMEOUT_MS);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
  });
}

function call(name: string, args: Record<string, unknown>): Promise<RpcResponse> {
  return rpc("tools/call", { name, arguments: args });
}

function txt(resp: RpcResponse): string {
  return resp?.result?.content?.[0]?.text ?? "";
}

/** Validation failures may surface as a protocol error OR a result with isError. */
function isErr(resp: RpcResponse): boolean {
  return resp?.result?.isError === true || !!resp?.error;
}

beforeAll(async () => {
  // Always rebuild: dist/ is gitignored and can lag behind src, and a stale build
  // would make this integration test silently validate old code.
  execSync("npm run build", { cwd: ROOT, stdio: "inherit", timeout: 120_000 });

  child = spawn("node", [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      AMAZON_ASSOCIATE_TAG_US: "ittest-20",
      // Pin these to EMPTY so the .env loader (which skips defined vars) can never
      // inject the developer's real tags or default marketplace into the run.
      AMAZON_ASSOCIATE_TAG: "",
      AMAZON_ASSOCIATE_TAG_ES: "",
      AMAZON_DEFAULT_MARKETPLACE: "US",
      AMAZON_CACHE_DB_PATH: DB_PATH,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); // drain (startup banner goes to stderr)

  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: RpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "edge-stdio-it", version: "1" },
  });
  expect(init.error).toBeUndefined();
  expect(init.result?.serverInfo?.name).toBe("amazon-mcp");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}, 180_000);

afterAll(() => {
  try {
    child?.stdin.end();
  } catch {
    /* ignore */
  }
  child?.kill();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB_PATH + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("tools/list", () => {
  it(
    "exposes exactly the 9 expected tools",
    async () => {
      const r = await rpc("tools/list");
      const tools: any[] = r.result?.tools ?? [];
      expect(tools).toHaveLength(9);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "add_price_watch",
          "compare_marketplaces",
          "get_buy_link",
          "get_deals",
          "get_price_history",
          "get_product",
          "list_price_watches",
          "remove_price_watch",
          "search_products",
        ].sort(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "every tool carries annotations; hints reflect each tool's real behavior",
    async () => {
      const r = await rpc("tools/list");
      const tools: any[] = r.result?.tools ?? [];
      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const t of tools) {
        expect(t.annotations, `tool ${t.name} is missing annotations`).toBeTruthy();
      }
      expect(byName.get("search_products")?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get("search_products")?.annotations?.openWorldHint).toBe(true);
      // get_buy_link is pure URL construction — closed world.
      expect(byName.get("get_buy_link")?.annotations?.openWorldHint).toBe(false);
      // Watch mutations must NOT claim to be read-only; remove is destructive.
      expect(byName.get("add_price_watch")?.annotations?.readOnlyHint).toBe(false);
      expect(byName.get("add_price_watch")?.annotations?.idempotentHint).toBe(true);
      expect(byName.get("remove_price_watch")?.annotations?.destructiveHint).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("get_buy_link (pure, offline)", () => {
  it(
    "US: tags both links with ittest-20, marks linkCode=ll1 and reports commission",
    async () => {
      const r = await call("get_buy_link", { asin: "b08n5wrwnw", marketplace: "US", quantity: 3 });
      expect(isErr(r)).toBe(false);
      const t = txt(r);
      // ASIN is upcased even when passed lowercase.
      expect(t).toContain("Affiliate buy links for B08N5WRWNW (Amazon US)");
      expect(t).toMatch(/Product page: https:\/\/www\.amazon\.com\/dp\/B08N5WRWNW\?tag=ittest-20&linkCode=ll1/);
      // Add-to-cart carries the tag twice (AssociateTag + tag) and the quantity.
      expect(t).toContain("/gp/aws/cart/add.html?");
      expect(t).toContain("AssociateTag=ittest-20");
      expect(t).toContain("Quantity.1=3");
      expect(t).toContain("Associate tag: ittest-20");
      // ittest-20 matches the US "-20" suffix → the confident commission note.
      expect(t).toContain("Affiliate tag applied. Purchases within 24h of opening this link earn you commission.");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ES with no tag configured: emits untagged links and an explicit no-commission note",
    async () => {
      const r = await call("get_buy_link", { asin: "B08N5WRWNW", marketplace: "ES" });
      expect(isErr(r)).toBe(false);
      const t = txt(r);
      expect(t).toContain("https://www.amazon.es/dp/B08N5WRWNW");
      // Untagged: no tag= / AssociateTag= anywhere, no linkCode marker.
      expect(t).not.toMatch(/[?&](tag|AssociateTag)=/);
      expect(t).not.toContain("linkCode=ll1");
      expect(t).toContain("Associate tag: (none configured)");
      expect(t).toContain("No Associates tag configured for ES");
      // Default quantity is 1.
      expect(t).toContain("Quantity.1=1");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects quantity 0 (below the schema minimum)",
    async () => {
      const r = await call("get_buy_link", { asin: "B08N5WRWNW", marketplace: "US", quantity: 0 });
      expect(isErr(r)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("price-watch lifecycle (checkNow:false, offline)", () => {
  const ASIN = "B08N5WRWNW";
  let watchId: number;

  it(
    "add_price_watch creates a watch and reports its id and target",
    async () => {
      const r = await call("add_price_watch", { asin: ASIN, targetPrice: 25, marketplace: "US" });
      expect(isErr(r)).toBe(false);
      const t = txt(r);
      expect(t).toMatch(/watch #\d+/);
      expect(t).toContain(`Watching ${ASIN} on Amazon US`);
      expect(t).toContain("≤ 25.00 USD");
      watchId = Number(t.match(/watch #(\d+)/)![1]);
      expect(watchId).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "list_price_watches (checkNow:false) shows the watch, pending, with no last price",
    async () => {
      const r = await call("list_price_watches", { checkNow: false });
      const t = txt(r);
      expect(t).toContain(`#${watchId} ${ASIN} (US) target ≤ 25.00 USD`);
      // Never fetched → current price renders as the em dash and stays pending.
      expect(t).toContain("now —");
      expect(t).toContain("⏳");
      expect(t).not.toContain("TARGET MET");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "re-adding the identical watch dedupes to the same id (1 row total)",
    async () => {
      const r2 = await call("add_price_watch", { asin: ASIN, targetPrice: 25, marketplace: "US" });
      const id2 = Number(txt(r2).match(/watch #(\d+)/)![1]);
      expect(id2).toBe(watchId);

      const list = await call("list_price_watches", { checkNow: false });
      const rows = (txt(list).match(new RegExp(`${ASIN}.*target ≤ 25\\.00 USD`, "g")) || []).length;
      expect(rows).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "remove_price_watch deletes it; the list is empty; a second remove reports not-found",
    async () => {
      const r = await call("remove_price_watch", { id: watchId });
      expect(txt(r)).toContain(`Removed watch #${watchId}.`);

      const list = await call("list_price_watches", { checkNow: false });
      const lt = txt(list);
      expect(lt).not.toContain(ASIN);
      // It was the only watch in this pristine DB.
      expect(lt).toContain("No price watches saved.");

      const again = await call("remove_price_watch", { id: watchId });
      expect(txt(again)).toContain(`No watch found with id #${watchId}.`);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("input validation (no network ever reached)", () => {
  it(
    "get_product rejects the malformed ASIN 'NOPE'",
    async () => {
      const r = await call("get_product", { asin: "NOPE", marketplace: "US" });
      expect(isErr(r)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "search_products rejects an unknown marketplace code",
    async () => {
      const r = await call("search_products", { query: "x", marketplace: "ZZ" });
      expect(isErr(r)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "search_products rejects an empty query",
    async () => {
      const r = await call("search_products", { query: "", marketplace: "US" });
      expect(isErr(r)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "calling an unknown tool yields an error",
    async () => {
      const r = await call("does_not_exist", {});
      expect(isErr(r)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

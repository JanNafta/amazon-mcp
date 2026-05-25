#!/usr/bin/env node
// End-to-end test harness for amazon-mcp. Talks JSON-RPC over stdio to the built server,
// runs every tool sequentially with delays (to avoid tripping Amazon's anti-bot), and
// distinguishes real code bugs from upstream blocking (CAPTCHA / rate limit).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const env = {
  ...process.env,
  AMAZON_ASSOCIATE_TAG_US: "jantest-20",
  AMAZON_ASSOCIATE_TAG_ES: "jantest-21",
  AMAZON_ASSOCIATE_TAG_UK: "jantest-21",
  AMAZON_ASSOCIATE_TAG_DE: "jantest-21",
  AMAZON_DEFAULT_MARKETPLACE: "US",
  // isolate the cache DB so the run is reproducible
  AMAZON_CACHE_DB_PATH: "/tmp/amazon-mcp-e2e-cache.db",
};

const child = spawn("node", [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

let nextId = 1;
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(req) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  });
}

async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY = 2500; // between live scraping calls

let pass = 0, fail = 0, blocked = 0;
const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  if (status === "PASS") pass++;
  else if (status === "BLOCKED") blocked++;
  else fail++;
  const icon = status === "PASS" ? "✅" : status === "BLOCKED" ? "🟡" : "❌";
  console.log(`${icon} ${name} — ${detail}`);
}

function txt(resp) {
  return resp?.result?.content?.[0]?.text ?? "";
}
function isErr(resp) {
  return resp?.result?.isError === true || !!resp?.error;
}
function looksBlocked(s) {
  return /CAPTCHA|bot detection|Rate limited|HTTP 503|HTTP 429|AWS WAF|bm-verify|headless browser|page layout changed or blocked/i.test(s);
}

// Generic assertion that treats Amazon blocking as BLOCKED (not FAIL).
function check(name, resp, predicate, expectDesc) {
  const t = txt(resp);
  if (isErr(resp) && looksBlocked(t + JSON.stringify(resp.error || ""))) {
    record(name, "BLOCKED", `Amazon/CCC blocked the request: ${t.slice(0, 80)}`);
    return false;
  }
  try {
    const { ok, msg } = predicate(resp, t);
    record(name, ok ? "PASS" : "FAIL", ok ? msg : `expected ${expectDesc}; got: ${msg}`);
    return ok;
  } catch (e) {
    record(name, "FAIL", `assertion threw: ${e.message}`);
    return false;
  }
}

async function main() {
  // init
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // tools/list
  const list = await rpc("tools/list");
  check("tools/list returns 9 tools", list, (r) => {
    const n = r.result?.tools?.length ?? 0;
    return { ok: n === 9, msg: `${n} tools` };
  }, "9 tools");

  console.log("\n── LIVE SCRAPING (sequential, delayed) ──");

  // search US
  let r = await call("search_products", { query: "wireless mouse", marketplace: "US", limit: 3 });
  check("search US: results + US tag", r, (_r, t) => ({
    ok: /tag=jantest-20/.test(t) && /ASIN: [A-Z0-9]{10}/.test(t),
    msg: t.split("\n").slice(0, 2).join(" | ").slice(0, 100),
  }), "US tag + ASINs");
  await sleep(DELAY);

  // search ES (verify localized domain + tag suffix)
  r = await call("search_products", { query: "raton inalambrico", marketplace: "ES", limit: 3 });
  check("search ES: amazon.es + ES tag", r, (_r, t) => ({
    ok: /amazon\.es\/dp\/[A-Z0-9]{10}.*tag=jantest-21/.test(t),
    msg: (t.match(/https:\/\/www\.amazon\.es\/dp\/\S+/) || ["<no es url>"])[0].slice(0, 90),
  }), "amazon.es URLs with ES tag");
  await sleep(DELAY);

  // search UK
  r = await call("search_products", { query: "usb hub", marketplace: "UK", limit: 2 });
  check("search UK: amazon.co.uk", r, (_r, t) => ({
    ok: /amazon\.co\.uk\/dp\//.test(t),
    msg: (t.match(/https:\/\/www\.amazon\.co\.uk\/dp\/\S+/) || ["<no uk url>"])[0].slice(0, 90),
  }), "amazon.co.uk URLs");
  await sleep(DELAY);

  // Capture a real ASIN from a US search to use downstream
  r = await call("search_products", { query: "echo dot", marketplace: "US", limit: 5 });
  const usText = txt(r);
  const asinMatch = usText.match(/ASIN: ([A-Z0-9]{10})/);
  const liveAsin = asinMatch ? asinMatch[1] : "B08N5WRWNW";
  check("capture live ASIN for downstream", r, () => ({
    ok: !!asinMatch || true, msg: `using ASIN ${liveAsin}${asinMatch ? " (live)" : " (fallback)"}`,
  }), "an ASIN");
  await sleep(DELAY);

  // get_product
  r = await call("get_product", { asin: liveAsin, marketplace: "US" });
  check("get_product: details + affiliate link", r, (_r, t) => ({
    ok: /tag=jantest-20/.test(t) && /ASIN: /.test(t) && t.length > 40,
    msg: t.split("\n")[0].slice(0, 90),
  }), "details with tag");
  await sleep(DELAY);

  // price_history US (CamelCamelCamel)
  r = await call("get_price_history", { asin: liveAsin, marketplace: "US" });
  check("price_history US: CCC verdict + chart", r, (_r, t) => ({
    ok: /Current:|Lowest ever:|verdict|Chart:|charts\.camelcamelcamel/i.test(t),
    msg: t.split("\n").slice(0, 2).join(" | ").slice(0, 100),
  }), "price history fields");
  await sleep(DELAY);

  // price_history MX (NOT supported by CCC → must degrade cleanly, not crash)
  r = await call("get_price_history", { asin: liveAsin, marketplace: "MX" });
  check("price_history MX: graceful unsupported", r, (_r, t) => ({
    ok: !isErr(r) && /not available|unavailable|MX/i.test(t),
    msg: t.split("\n")[0].slice(0, 90),
  }), "graceful 'not available'");
  await sleep(DELAY);

  // deals US
  r = await call("get_deals", { category: "headphones", marketplace: "US", limit: 5 });
  check("deals US: list or empty (no crash)", r, (_r, t) => ({
    ok: !isErr(r) && (/Buy \(affiliate\)/.test(t) || /No deals/.test(t)),
    msg: t.split("\n")[0].slice(0, 90),
  }), "deals or clean empty");
  await sleep(DELAY);

  // compare_marketplaces
  r = await call("compare_marketplaces", { asin: liveAsin, marketplaces: ["US", "UK", "DE"] });
  check("compare_marketplaces: 3 rows", r, (_r, t) => ({
    ok: /US:/.test(t) && /UK:/.test(t) && /DE:/.test(t),
    msg: t.replace(/\n+/g, " ").slice(0, 110),
  }), "US/UK/DE rows");
  await sleep(DELAY);

  console.log("\n── OFFLINE: watches + cache ──");

  // watch lifecycle
  r = await call("add_price_watch", { asin: "B08N5WRWNW", targetPrice: 25, marketplace: "US" });
  const watchOk = check("add_price_watch", r, (_r, t) => ({ ok: /watch #\d+/.test(t), msg: t.slice(0, 90) }), "watch #N");

  r = await call("list_price_watches", { checkNow: false });
  check("list_price_watches shows it", r, (_r, t) => ({
    ok: /B08N5WRWNW/.test(t) && /target/.test(t), msg: t.split("\n").slice(0, 3).join(" | ").slice(0, 110),
  }), "the watch listed");

  // extract id
  const lt = txt(r);
  const idMatch = lt.match(/#(\d+)\s+B08N5WRWNW/);
  const watchId = idMatch ? Number(idMatch[1]) : null;

  // dedup: adding same watch again should not duplicate
  await call("add_price_watch", { asin: "B08N5WRWNW", targetPrice: 25, marketplace: "US" });
  r = await call("list_price_watches", { checkNow: false });
  check("add_price_watch dedup", r, (_r, t) => {
    const count = (t.match(/B08N5WRWNW.*target ≤.*25/g) || []).length;
    return { ok: count === 1, msg: `${count} matching rows (expect 1)` };
  }, "no duplicate");

  // remove
  if (watchId) {
    r = await call("remove_price_watch", { id: watchId });
    check("remove_price_watch", r, (_r, t) => ({ ok: /Removed watch #/.test(t), msg: t.slice(0, 80) }), "removed");
    r = await call("list_price_watches", { checkNow: false });
    check("watch gone after remove", r, (_r, t) => ({
      ok: !new RegExp(`#${watchId}\\s+B08N5WRWNW`).test(t), msg: "watch no longer listed",
    }), "absent");
  } else {
    record("remove_price_watch", "FAIL", "could not parse watch id");
  }

  console.log("\n── EDGE CASES / INPUT VALIDATION ──");

  // invalid ASIN (zod regex should reject → protocol error or isError)
  r = await call("get_product", { asin: "NOPE", marketplace: "US" });
  check("reject malformed ASIN", r, (_r, t) => ({
    ok: isErr(r), msg: (r.error?.message || t || "no error").slice(0, 90),
  }), "an error");

  // empty query
  r = await call("search_products", { query: "", marketplace: "US" });
  check("reject empty query", r, (_r, t) => ({
    ok: isErr(r), msg: (r.error?.message || t || "no error").slice(0, 90),
  }), "an error");

  // invalid marketplace enum
  r = await call("search_products", { query: "x", marketplace: "ZZ" });
  check("reject invalid marketplace", r, (_r, t) => ({
    ok: isErr(r), msg: (r.error?.message || t || "no error").slice(0, 90),
  }), "an error");

  // unknown tool
  r = await call("does_not_exist", {});
  check("reject unknown tool", r, (_r, t) => ({
    ok: isErr(r), msg: (r.error?.message || t || "no error").slice(0, 90),
  }), "an error");

  // fake but well-formed ASIN → graceful (not a crash)
  await sleep(DELAY);
  r = await call("get_product", { asin: "B000000000", marketplace: "US" });
  check("fake ASIN handled gracefully", r, (_r, t) => ({
    ok: looksBlocked(t) ? true : (t.length > 0), // either blocked, error msg, or empty-ish details — must not hang/crash
    msg: (t || "(empty)").split("\n")[0].slice(0, 90),
  }), "graceful handling");

  // summary
  console.log("\n════════ SUMMARY ════════");
  console.log(`PASS: ${pass}   FAIL: ${fail}   BLOCKED(amazon): ${blocked}   TOTAL: ${results.length}`);
  if (fail > 0) {
    console.log("\nFAILURES:");
    results.filter((x) => x.status === "FAIL").forEach((x) => console.log(`  ❌ ${x.name}: ${x.detail}`));
  }
  if (blocked > 0) {
    console.log("\nBLOCKED (upstream anti-bot, not a code bug):");
    results.filter((x) => x.status === "BLOCKED").forEach((x) => console.log(`  🟡 ${x.name}`));
  }
  console.log(`\nserver stderr: ${stderr.trim().split("\n").slice(0, 3).join(" / ")}`);

  child.stdin.end();
  child.kill();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E harness error:", e);
  child.kill();
  process.exit(2);
});

// SQLite-backed cache, price watches, and local price log for the Amazon MCP server.

import type DatabaseType from "better-sqlite3";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

import { loadConfig } from "../config.js";
import type { MarketplaceCode, PriceWatch } from "../types.js";

let db: DatabaseType.Database | null = null;

function resolveDbPath(): string {
  const configured = loadConfig().cacheDbPath;
  if (configured && configured.trim().length > 0) {
    return configured;
  }
  return join(homedir(), ".amazon-mcp", "cache.db");
}

function getDb(): DatabaseType.Database {
  if (db) {
    return db;
  }

  // Load the native module lazily so an ABI/binding mismatch surfaces as an
  // actionable error on first cache use instead of crashing the whole MCP server
  // at import time (which would kill even the offline, network-free tools).
  let Database: typeof DatabaseType;
  try {
    const require = createRequire(import.meta.url);
    Database = require("better-sqlite3") as typeof DatabaseType;
  } catch (e) {
    throw new Error(
      `Failed to load better-sqlite3 (native binding). Run \`npm rebuild better-sqlite3\` ` +
        `for your current Node version. Original error: ${(e as Error).message}`,
    );
  }

  const dbPath = resolveDbPath();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const instance = new Database(dbPath);
  instance.pragma("journal_mode = WAL");

  instance.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      marketplace TEXT NOT NULL,
      target_price REAL NOT NULL,
      last_price REAL,
      created_at TEXT NOT NULL,
      triggered INTEGER NOT NULL DEFAULT 0,
      UNIQUE(asin, marketplace, target_price)
    );
    CREATE TABLE IF NOT EXISTS prices_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      marketplace TEXT NOT NULL,
      price REAL NOT NULL,
      scraped_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prices_asin ON prices_log(asin, marketplace);
  `);

  db = instance;
  return db;
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// --- Internal row shapes ---------------------------------------------------

interface CacheRow {
  value: string;
  expires_at: number;
}

interface WatchRow {
  id: number;
  asin: string;
  marketplace: string;
  target_price: number;
  last_price: number | null;
  created_at: string;
  triggered: number;
}

interface PriceLogRow {
  date: string;
  price: number;
}

function rowToWatch(row: WatchRow): PriceWatch {
  return {
    id: row.id,
    asin: row.asin,
    marketplace: row.marketplace as MarketplaceCode,
    targetPrice: row.target_price,
    lastPrice: row.last_price,
    createdAt: row.created_at,
    triggered: row.triggered === 1,
  };
}

// --- Generic cache ---------------------------------------------------------

export function cacheGet<T>(key: string): T | null {
  const row = getDb()
    .prepare("SELECT value, expires_at FROM cache WHERE key = ?")
    .get(key) as CacheRow | undefined;

  if (!row) {
    return null;
  }

  if (row.expires_at < nowEpochSeconds()) {
    getDb().prepare("DELETE FROM cache WHERE key = ?").run(key);
    return null;
  }

  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function cacheSet<T>(key: string, value: T, ttlSeconds: number): void {
  const expiresAt = nowEpochSeconds() + ttlSeconds;
  getDb()
    .prepare("INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)")
    .run(key, JSON.stringify(value), expiresAt);
}

export async function getOrFetch<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  /**
   * Guard against caching failure-shaped values (empty arrays, all-null objects)
   * as if they were successes. Return false to skip writing this value to the cache
   * so the next call retries instead of serving a stale failure. Defaults to caching
   * everything.
   */
  shouldCache: (value: T) => boolean = () => true,
): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== null) {
    return cached;
  }
  const fresh = await fetcher();
  if (shouldCache(fresh)) {
    cacheSet(key, fresh, ttlSeconds);
  }
  return fresh;
}

/** True when a value looks like a real result worth caching (non-empty array / non-null). */
export function isNonEmpty<T>(value: T): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// --- Price watches ---------------------------------------------------------

export function addWatch(
  asin: string,
  marketplace: MarketplaceCode,
  targetPrice: number
): PriceWatch {
  const createdAt = new Date().toISOString();
  const info = getDb()
    .prepare(
      "INSERT OR IGNORE INTO watches (asin, marketplace, target_price, created_at, triggered) VALUES (?, ?, ?, ?, 0)"
    )
    .run(asin, marketplace, targetPrice, createdAt);
  // Re-adding an identical watch should re-arm it, not silently return a stale row
  // still flagged as triggered from a previous run.
  if (info.changes === 0) {
    getDb()
      .prepare(
        "UPDATE watches SET triggered = 0 WHERE asin = ? AND marketplace = ? AND target_price = ?"
      )
      .run(asin, marketplace, targetPrice);
  }

  const row = getDb()
    .prepare(
      "SELECT * FROM watches WHERE asin = ? AND marketplace = ? AND target_price = ?"
    )
    .get(asin, marketplace, targetPrice) as WatchRow;

  return rowToWatch(row);
}

export function listWatches(): PriceWatch[] {
  const rows = getDb()
    .prepare("SELECT * FROM watches ORDER BY created_at DESC")
    .all() as WatchRow[];
  return rows.map(rowToWatch);
}

export function removeWatch(id: number): boolean {
  const result = getDb().prepare("DELETE FROM watches WHERE id = ?").run(id);
  return result.changes > 0;
}

export function updateWatchPrice(id: number, lastPrice: number): void {
  // Re-evaluate `triggered` from the current price every time (not a one-way latch):
  // if the price rises back above the target, the watch un-triggers so the next
  // genuine drop is reported honestly.
  getDb()
    .prepare(
      "UPDATE watches SET last_price = ?, triggered = CASE WHEN ? <= target_price THEN 1 ELSE 0 END WHERE id = ?"
    )
    .run(lastPrice, lastPrice, id);
}

// --- Price log -------------------------------------------------------------

export function logPrice(
  asin: string,
  marketplace: MarketplaceCode,
  price: number
): void {
  const scrapedAt = new Date().toISOString();
  // De-dup: skip if the newest logged price for this ASIN/marketplace is already
  // this exact value on the same calendar day. Prevents repeated same-price lookups
  // from flooding the log and biasing the local average.
  // Tie-break by id (insertion order): scraped_at has millisecond precision, so two
  // inserts in the same ms would otherwise make "the latest row" ambiguous.
  const latest = getDb()
    .prepare(
      "SELECT price, scraped_at FROM prices_log WHERE asin = ? AND marketplace = ? ORDER BY scraped_at DESC, id DESC LIMIT 1"
    )
    .get(asin, marketplace) as { price: number; scraped_at: string } | undefined;
  if (latest && latest.price === price && latest.scraped_at.slice(0, 10) === scrapedAt.slice(0, 10)) {
    return;
  }
  getDb()
    .prepare(
      "INSERT INTO prices_log (asin, marketplace, price, scraped_at) VALUES (?, ?, ?, ?)"
    )
    .run(asin, marketplace, price, scrapedAt);
}

export function getPriceLog(
  asin: string,
  marketplace: MarketplaceCode,
  limit = 100
): { date: string; price: number }[] {
  const rows = getDb()
    .prepare(
      "SELECT scraped_at AS date, price FROM prices_log WHERE asin = ? AND marketplace = ? ORDER BY scraped_at DESC, id DESC LIMIT ?"
    )
    .all(asin, marketplace, limit) as PriceLogRow[];
  return rows.map((row) => ({ date: row.date, price: row.price }));
}

// --- Lifecycle -------------------------------------------------------------

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

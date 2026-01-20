// src/app/api/network/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getNetworkFidsFromHub } from "@/lib/hub";
import { getRedis } from "@/lib/redis";

type Mode = "followers" | "following" | "both";

type NeynarBulkResp = {
  users: Array<{
    fid: number;
    username: string;
    display_name?: string;
    pfp_url?: string;

    score?: number;
    experimental?: { neynar_user_score?: number };

    profile?: {
      location?: {
        latitude?: number;
        longitude?: number;
        address?: {
          city?: string;
          state?: string;
          country?: string;
        };
      };
    };
  }>;
};

type PinUser = {
  fid: number;
  username: string;
  display_name?: string;
  pfp_url?: string;
  score: number;
};

export type PinPoint = {
  lat: number;
  lng: number;
  city: string;
  count: number;
  users: PinUser[];
};

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function getUserScore(u: NeynarBulkResp["users"][number]): number | null {
  const s =
    typeof u.score === "number"
      ? u.score
      : typeof u.experimental?.neynar_user_score === "number"
      ? u.experimental.neynar_user_score
      : null;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

function formatCity(u: NeynarBulkResp["users"][number]) {
  const a = u.profile?.location?.address;
  const parts = [a?.city, a?.state, a?.country].filter(Boolean);
  return parts.length ? parts.join(", ") : "Unknown";
}

function roundCoord(n: number, decimals = 2) {
  const p = Math.pow(10, decimals);
  return Math.round(n * p) / p;
}

/* ──────────────────────────────────────────────────────────────
   L1 caches (in-memory) + L2 caches (Redis)
   Store only minimal user fields in caches to save a lot of space.
   ────────────────────────────────────────────────────────────── */

type MiniUser = {
  fid: number;
  username: string;
  display_name?: string;
  pfp_url?: string;

  // Resolved score (null if missing)
  score: number | null;

  // coords as int(*100) to save space (represents lat/lng rounded to 2 decimals)
  latE2?: number;
  lngE2?: number;

  city?: string; // only when location present (or keep undefined)
  updatedAt: number; // ms
};

type CachedUser = {
  user: MiniUser;
  ts: number; // cached at (ms)
};

type CachedNetwork = {
  followers: number[];
  following: number[];
  ts: number;
};

const g = globalThis as any;

// L1 TTLs (warm instance)
const USER_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const NETWORK_TTL_MS = 2 * 60 * 1000; // 2 minutes

// L2 TTLs (Redis)
const USER_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const NETWORK_TTL_SECONDS = 10 * 60; // 10 minutes

const MAX_USER_CACHE = 50_000;
const MAX_NETWORK_CACHE = 2_000;

if (!g.__FARMAPS_USER_CACHE__) g.__FARMAPS_USER_CACHE__ = new Map<number, CachedUser>();
if (!g.__FARMAPS_NETWORK_CACHE__) g.__FARMAPS_NETWORK_CACHE__ = new Map<string, CachedNetwork>();

const userCache: Map<number, CachedUser> = g.__FARMAPS_USER_CACHE__;
const networkCache: Map<string, CachedNetwork> = g.__FARMAPS_NETWORK_CACHE__;

function isFresh(ts: number, ttl: number) {
  return Date.now() - ts <= ttl;
}

function pruneCache<K, V extends { ts: number }>(m: Map<K, V>, maxSize: number) {
  if (m.size <= maxSize) return;
  const target = Math.max(1, Math.floor(maxSize * 0.1));
  const entries = Array.from(m.entries());
  entries.sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < Math.min(target, entries.length); i++) {
    m.delete(entries[i][0]);
  }
}

function getNetworkCacheKey(args: {
  fid: number;
  mode: Mode;
  limitEachRaw: string;
  maxEach: number;
  hubPageSize: number;
  hubDelayMs: number;
  minScore: number;
  concurrency: number;
}) {
  // include the things that materially change the result
  return [
    `fid=${args.fid}`,
    `mode=${args.mode}`,
    `limitEach=${args.limitEachRaw}`,
    `maxEach=${args.maxEach}`,
    `hubPageSize=${args.hubPageSize}`,
    `hubDelayMs=${args.hubDelayMs}`,
    `minScore=${args.minScore}`,
    `conc=${args.concurrency}`,
  ].join("|");
}

// Shorter keys save memory at scale
function redisNetKey(k: string) {
  return `fn1:${k}`;
}
function redisUserKey(fid: number) {
  return `fu1:${fid}`;
}

async function redisGetJson<T>(key: string): Promise<T | null> {
  try {
    const r = await getRedis();
    const s = await r.get(key);
    if (!s) return null;
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

async function redisSetJson(key: string, value: any, ttlSeconds: number) {
  try {
    const r = await getRedis();
    await r.setEx(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // ignore Redis errors (app should still work)
  }
}

async function redisMGetUsers(fids: number[]) {
  const out = new Map<number, CachedUser>();
  if (!fids.length) return out;

  try {
    const r = await getRedis();
    const keys = fids.map((fid) => redisUserKey(fid));
    const vals = await r.mGet(keys);

    const now = Date.now();
    for (let i = 0; i < fids.length; i++) {
      const raw = vals[i];
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as CachedUser;
        if (parsed && parsed.user && typeof parsed.user.fid === "number") {
          out.set(fids[i], { user: parsed.user, ts: now });
        }
      } catch {
        // ignore bad JSON
      }
    }
  } catch {
    // ignore Redis errors
  }

  return out;
}

function toE2(n: number) {
  return Math.round(n * 100);
}
function fromE2(n: number) {
  return n / 100;
}

function toMiniUser(u: NeynarBulkResp["users"][number], now: number): MiniUser | null {
  if (typeof u?.fid !== "number" || !Number.isFinite(u.fid)) return null;

  const score = getUserScore(u); // number | null

  const lat0 = u.profile?.location?.latitude;
  const lng0 = u.profile?.location?.longitude;

  const hasLoc =
    typeof lat0 === "number" &&
    typeof lng0 === "number" &&
    Number.isFinite(lat0) &&
    Number.isFinite(lng0) &&
    lat0 >= -90 &&
    lat0 <= 90 &&
    lng0 >= -180 &&
    lng0 <= 180;

  const mini: MiniUser = {
    fid: u.fid,
    username: u.username,
    display_name: u.display_name,
    pfp_url: u.pfp_url,
    score,
    updatedAt: now,
  };

  if (hasLoc) {
    const lat = roundCoord(lat0, 2);
    const lng = roundCoord(lng0, 2);
    mini.latE2 = toE2(lat);
    mini.lngE2 = toE2(lng);
    mini.city = formatCity(u);
  }

  return mini;
}

async function neynarUserBulk(fids: number[]): Promise<NeynarBulkResp> {
  const apiKey = mustEnv("NEYNAR_API_KEY");

  const url = `https://api.neynar.com/v2/farcaster/user/bulk?fids=${encodeURIComponent(
    fids.join(",")
  )}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", api_key: apiKey } as any,
      cache: "no-store",
      signal: controller.signal,
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg = json?.message || json?.error || `Neynar error ${res.status}`;
      const err = new Error(
        `[Neynar] ${msg} (${res.status})${text ? ` body=${text.slice(0, 200)}` : ""}`
      );
      (err as any).status = res.status;
      throw err;
    }

    if (!json) throw new Error("[Neynar] Empty/non-JSON response");
    return json as NeynarBulkResp;
  } catch (e: any) {
    const cause = e?.name === "AbortError" ? "timeout" : e?.message || String(e);
    console.warn("[Neynar] hydrate skipped:", cause);
    return { users: [] };
  } finally {
    clearTimeout(t);
  }
}

async function neynarBulkWithRetry(fids: number[], maxAttempts = 5) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await neynarUserBulk(fids);
    } catch (e: any) {
      const status = e?.status;
      const msg = e?.message || "";
      const retryable =
        status === 429 ||
        (typeof status === "number" && status >= 500) ||
        msg.includes("(timeout)");

      if (!retryable || attempt >= maxAttempts) throw e;

      const backoff = Math.min(10_000, 500 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      await sleep(backoff + jitter);
    }
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;

  const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

async function hydrateUsersCached(
  fids: number[],
  concurrency: number
): Promise<{
  users: MiniUser[];
  cacheHits: number; // L1 hits
  redisHits: number; // L2 hits
  fetchedCount: number;
  requested: number;
}> {
  const now = Date.now();

  const freshUsers: MiniUser[] = [];
  const missingL1: number[] = [];

  let cacheHits = 0;

  // 1) L1 (memory)
  for (const fid of fids) {
    const c = userCache.get(fid);
    if (c && isFresh(c.ts, USER_TTL_MS)) {
      freshUsers.push(c.user);
      cacheHits++;
    } else {
      missingL1.push(fid);
    }
  }

  // 2) L2 (Redis) for the ones not in L1
  const fromRedis = await redisMGetUsers(missingL1);
  let redisHits = 0;
  const missing: number[] = [];

  for (const fid of missingL1) {
    const c = fromRedis.get(fid);
    if (c) {
      userCache.set(fid, c);
      redisHits++;
    } else {
      missing.push(fid);
    }
  }

  pruneCache(userCache, MAX_USER_CACHE);

  // 3) Fetch remaining from Neynar
  let fetchedMini: MiniUser[] = [];
  if (missing.length) {
    const batches = chunk(missing, 100);

    const bulkResults = await mapPool(batches, concurrency, async (b) => {
      return await neynarBulkWithRetry(b, 5);
    });

    const fetchedRaw: NeynarBulkResp["users"] = [];
    for (const r of bulkResults) {
      const list = Array.isArray(r.users) ? r.users : [];
      fetchedRaw.push(...list);
    }

    // Transform -> minimal record and write to L1 + L2
    for (const u of fetchedRaw) {
      const mini = toMiniUser(u, now);
      if (!mini) continue;

      fetchedMini.push(mini);

      const cached: CachedUser = { user: mini, ts: now };
      userCache.set(mini.fid, cached);

      // fire-and-forget (don’t await each one)
      void redisSetJson(redisUserKey(mini.fid), cached, USER_TTL_SECONDS);
    }

    pruneCache(userCache, MAX_USER_CACHE);
  }

  // Merge L1 + L2 + fetched (dedupe)
  const byFid = new Map<number, MiniUser>();
  for (const u of freshUsers) byFid.set(u.fid, u);
  for (const c of fromRedis.values()) byFid.set(c.user.fid, c.user);
  for (const u of fetchedMini) byFid.set(u.fid, u);

  return {
    users: Array.from(byFid.values()),
    cacheHits,
    redisHits,
    fetchedCount: fetchedMini.length,
    requested: fids.length,
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const fidStr = searchParams.get("fid");
    const fid = fidStr ? Number(fidStr) : NaN;
    if (!fidStr || !Number.isFinite(fid) || fid <= 0) {
      return NextResponse.json({ error: "Missing or invalid fid" }, { status: 400 });
    }

    const mode = (searchParams.get("mode") || "both") as Mode;
    if (mode !== "followers" && mode !== "following" && mode !== "both") {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }

    const limitEachRaw = searchParams.get("limitEach") || "200";
    const limitEach = limitEachRaw === "all" ? ("all" as const) : Number(limitEachRaw);

    const maxEachParam = Number(searchParams.get("maxEach") || "20000");
    const maxEach = Number.isFinite(maxEachParam)
      ? Math.min(Math.max(maxEachParam, 1000), 100000)
      : 20000;

    const minScoreParam = Number(searchParams.get("minScore") || "0.8");
    const minScore = Number.isFinite(minScoreParam) ? minScoreParam : 0.8;

    const concurrencyParam = Number(searchParams.get("concurrency") || "4");
    const concurrency = Number.isFinite(concurrencyParam)
      ? Math.min(Math.max(concurrencyParam, 1), 8)
      : 4;

    const hubPageSize = Math.min(Math.max(Number(searchParams.get("hubPageSize") || "50"), 10), 200);
    const hubDelayMs = Math.min(Math.max(Number(searchParams.get("hubDelayMs") || "150"), 0), 2000);

    const includeFollowers = mode === "followers" || mode === "both";
    const includeFollowing = mode === "following" || mode === "both";

    // ── Network cache key includes parameters that affect output ──
    const cacheKey = getNetworkCacheKey({
      fid,
      mode,
      limitEachRaw,
      maxEach,
      hubPageSize,
      hubDelayMs,
      minScore,
      concurrency,
    });

    // ── L1 network cache first ──
    const cachedNet = networkCache.get(cacheKey);

    let followers: number[] = [];
    let following: number[] = [];
    let networkCacheHit = false;
    let networkRedisHit = false;

    if (cachedNet && isFresh(cachedNet.ts, NETWORK_TTL_MS)) {
      followers = cachedNet.followers;
      following = cachedNet.following;
      networkCacheHit = true;
    } else {
      // ── L2 network cache (Redis) ──
      const redisNet = await redisGetJson<CachedNetwork>(redisNetKey(cacheKey));
      if (redisNet?.followers && redisNet?.following) {
        followers = redisNet.followers;
        following = redisNet.following;
        networkRedisHit = true;

        // warm L1
        networkCache.set(cacheKey, { followers, following, ts: Date.now() });
        pruneCache(networkCache, MAX_NETWORK_CACHE);
      } else {
        // ── Hub fetch ──
        const net = await getNetworkFidsFromHub(fid, {
          includeFollowers,
          includeFollowing,
          limitEach: limitEach as any,
          maxEach,
        });

        followers = net.followers;
        following = net.following;

        const entry: CachedNetwork = { followers, following, ts: Date.now() };

        networkCache.set(cacheKey, entry);
        pruneCache(networkCache, MAX_NETWORK_CACHE);

        // write to Redis
        await redisSetJson(redisNetKey(cacheKey), entry, NETWORK_TTL_SECONDS);
      }
    }

    const merged = Array.from(new Set([fid, ...followers, ...following]));

    const hydrate = await hydrateUsersCached(merged, concurrency);
    const allUsers = hydrate.users;

    const viewerUser = allUsers.find((u) => u.fid === fid);
    const viewer = viewerUser
      ? {
          fid,
          username: viewerUser.username,
          display_name: viewerUser.display_name,
          pfp_url: viewerUser.pfp_url,
        }
      : { fid };

    let scoredOk = 0;
    let missingScore = 0;
    let withLocation = 0;

    const grouped = new Map<string, PinPoint>();

    for (const u of allUsers) {
      const score = u.score;
      if (score === null) {
        missingScore++;
        continue;
      }
      if (score <= minScore) continue;
      scoredOk++;

      if (typeof u.latE2 !== "number" || typeof u.lngE2 !== "number") continue;

      withLocation++;

      const lat = fromE2(u.latE2);
      const lng = fromE2(u.lngE2);
      const key = `${lat},${lng}`;

      const city = u.city || "Unknown";

      const user: PinUser = {
        fid: u.fid,
        username: u.username,
        display_name: u.display_name,
        pfp_url: u.pfp_url,
        score,
      };

      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, { lat, lng, city, count: 1, users: [user] });
      } else {
        existing.count += 1;
        existing.users.push(user);
        if (existing.city === "Unknown" && city !== "Unknown") existing.city = city;
      }
    }

    const points: PinPoint[] = Array.from(grouped.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.city.localeCompare(b.city);
    });

    return NextResponse.json(
      {
        fid,
        mode,
        minScore,
        limitEach: limitEachRaw,
        maxEach,
        concurrency,
        hubPageSize,
        hubDelayMs,

        viewer,

        followersCount: followers.length,
        followingCount: following.length,
        hydrated: allUsers.length,
        scoredOk,
        missingScore,
        withLocation,
        count: points.length,

        cache: {
          network: {
            hitL1: networkCacheHit,
            hitRedis: networkRedisHit,
            ttlMs: NETWORK_TTL_MS,
            ttlSecondsRedis: NETWORK_TTL_SECONDS,
            size: networkCache.size,
          },
          users: {
            requested: hydrate.requested,
            cacheHitsL1: hydrate.cacheHits,
            cacheHitsRedis: hydrate.redisHits,
            fetchedCount: hydrate.fetchedCount,
            ttlMs: USER_TTL_MS,
            ttlSecondsRedis: USER_TTL_SECONDS,
            size: userCache.size,
          },
        },

        points,
      },
      {
        // CDN caching helps too (doesn't replace Redis)
        headers: {
          "Cache-Control": "s-maxage=60, stale-while-revalidate=600",
        },
      }
    );
  } catch (e: any) {
    console.error("api/network error:", e);
    return NextResponse.json({ error: e?.message || "Server error" }, { status: 500 });
  }
}

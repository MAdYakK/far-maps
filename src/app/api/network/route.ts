export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getNetworkFidsFromHub } from "@/lib/hub";

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
   In-memory caches (best effort; persists per warm instance)
   ────────────────────────────────────────────────────────────── */

type CachedUser = {
  user: NeynarBulkResp["users"][number];
  ts: number; // cached at
};

type CachedNetwork = {
  followers: number[];
  following: number[];
  ts: number;
};

// Make caches survive hot reloads/dev and share across requests in same process
const g = globalThis as any;

const USER_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const NETWORK_TTL_MS = 2 * 60 * 1000; // 2 minutes

const MAX_USER_CACHE = 50_000; // adjust if needed
const MAX_NETWORK_CACHE = 2_000;

if (!g.__FARMAPS_USER_CACHE__) g.__FARMAPS_USER_CACHE__ = new Map<number, CachedUser>();
if (!g.__FARMAPS_NETWORK_CACHE__) g.__FARMAPS_NETWORK_CACHE__ = new Map<string, CachedNetwork>();

const userCache: Map<number, CachedUser> = g.__FARMAPS_USER_CACHE__;
const networkCache: Map<string, CachedNetwork> = g.__FARMAPS_NETWORK_CACHE__;

function isFresh(ts: number, ttl: number) {
  return Date.now() - ts <= ttl;
}

// Very simple pruning to keep memory bounded
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
}) {
  return `${args.fid}|${args.mode}|limitEach=${args.limitEachRaw}|maxEach=${args.maxEach}|pageSize=${args.hubPageSize}|delay=${args.hubDelayMs}`;
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
  users: NeynarBulkResp["users"];
  cacheHits: number;
  fetchedCount: number;
  requested: number;
}> {
  const now = Date.now();
  const freshUsers: NeynarBulkResp["users"] = [];
  const missing: number[] = [];

  let cacheHits = 0;

  for (const fid of fids) {
    const c = userCache.get(fid);
    if (c && isFresh(c.ts, USER_TTL_MS)) {
      freshUsers.push(c.user);
      cacheHits++;
    } else {
      missing.push(fid);
    }
  }

  let fetchedUsers: NeynarBulkResp["users"] = [];
  if (missing.length) {
    const batches = chunk(missing, 100);

    const bulkResults = await mapPool(batches, concurrency, async (b) => {
      return await neynarBulkWithRetry(b, 5);
    });

    for (const r of bulkResults) {
      const list = Array.isArray(r.users) ? r.users : [];
      fetchedUsers.push(...list);
    }

    for (const u of fetchedUsers) {
      if (typeof u?.fid === "number") {
        userCache.set(u.fid, { user: u, ts: now });
      }
    }

    pruneCache(userCache, MAX_USER_CACHE);
  }

  const byFid = new Map<number, NeynarBulkResp["users"][number]>();
  for (const u of freshUsers) byFid.set(u.fid, u);
  for (const u of fetchedUsers) byFid.set(u.fid, u);

  return {
    users: Array.from(byFid.values()),
    cacheHits,
    fetchedCount: fetchedUsers.length,
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

    // Hub pacing passthrough (used inside lib/hub if you add it there later)
    const hubPageSize = Math.min(Math.max(Number(searchParams.get("hubPageSize") || "50"), 10), 200);
    const hubDelayMs = Math.min(Math.max(Number(searchParams.get("hubDelayMs") || "150"), 0), 2000);

    const includeFollowers = mode === "followers" || mode === "both";
    const includeFollowing = mode === "following" || mode === "both";

    const cacheKey = getNetworkCacheKey({ fid, mode, limitEachRaw, maxEach, hubPageSize, hubDelayMs });
    const cachedNet = networkCache.get(cacheKey);

    let followers: number[] = [];
    let following: number[] = [];
    let networkCacheHit = false;

    if (cachedNet && isFresh(cachedNet.ts, NETWORK_TTL_MS)) {
      followers = cachedNet.followers;
      following = cachedNet.following;
      networkCacheHit = true;
    } else {
      const net = await getNetworkFidsFromHub(fid, {
        includeFollowers,
        includeFollowing,
        limitEach: limitEach as any,
        maxEach,
        // (optional) if you later add these into lib/hub:
        // hubPageSize,
        // hubDelayMs,
      });

      followers = net.followers;
      following = net.following;

      networkCache.set(cacheKey, { followers, following, ts: Date.now() });
      pruneCache(networkCache, MAX_NETWORK_CACHE);
    }

    const merged = Array.from(new Set([fid, ...followers, ...following]));

    const hydrate = await hydrateUsersCached(merged, concurrency);
    const allUsers = hydrate.users;

    // viewer info for watermarking
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
      const score = getUserScore(u);
      if (score === null) {
        missingScore++;
        continue;
      }
      if (score <= minScore) continue;
      scoredOk++;

      const lat0 = u.profile?.location?.latitude;
      const lng0 = u.profile?.location?.longitude;
      if (typeof lat0 !== "number" || typeof lng0 !== "number") continue;

      if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) continue;
      if (lat0 < -90 || lat0 > 90 || lng0 < -180 || lng0 > 180) continue;

      withLocation++;

      const lat = roundCoord(lat0, 2);
      const lng = roundCoord(lng0, 2);
      const key = `${lat},${lng}`;

      const city = formatCity(u);

      const user: PinUser = {
        fid: u.fid,
        username: u.username,
        display_name: u.display_name,
        pfp_url: u.pfp_url,
        score,
      };

      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          lat,
          lng,
          city,
          count: 1,
          users: [user],
        });
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

    return NextResponse.json({
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
          hit: networkCacheHit,
          ttlMs: NETWORK_TTL_MS,
          size: networkCache.size,
        },
        users: {
          requested: hydrate.requested,
          cacheHits: hydrate.cacheHits,
          fetchedCount: hydrate.fetchedCount,
          ttlMs: USER_TTL_MS,
          size: userCache.size,
        },
      },

      points,
    });
  } catch (e: any) {
    console.error("api/network error:", e);
    return NextResponse.json({ error: e?.message || "Server error" }, { status: 500 });
  }
}

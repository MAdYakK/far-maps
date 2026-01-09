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

type PinPoint = {
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

async function neynarUserBulk(fids: number[]): Promise<NeynarBulkResp> {
  const apiKey = mustEnv("NEYNAR_API_KEY");

  const url = `https://api.neynar.com/v2/farcaster/user/bulk?fids=${encodeURIComponent(
    fids.join(",")
  )}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12_000);

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
      throw new Error(
        `[Neynar] ${msg} (${res.status})${text ? ` body=${text.slice(0, 200)}` : ""}`
      );
    }

    if (!json) throw new Error("[Neynar] Empty/non-JSON response");
    return json as NeynarBulkResp;
  } catch (e: any) {
    const cause = e?.name === "AbortError" ? "timeout" : e?.message || String(e);
    throw new Error(`[Neynar] fetch failed (${cause})`);
  } finally {
    clearTimeout(t);
  }
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

    const limitEachParam = Number(searchParams.get("limitEach") || "200");
    const limitEach = Number.isFinite(limitEachParam)
      ? Math.min(Math.max(limitEachParam, 50), 2000)
      : 200;

    const minScoreParam = Number(searchParams.get("minScore") || "0.8");
    const minScore = Number.isFinite(minScoreParam) ? minScoreParam : 0.8;

    // 1) Hub: get follower +/or following FIDs (free)
    const includeFollowers = mode === "followers" || mode === "both";
    const includeFollowing = mode === "following" || mode === "both";

    const { followers, following } = await getNetworkFidsFromHub(fid, {
      includeFollowers,
      includeFollowing,
      limitEach,
    });

    // include self so you can always show yourself if you have location/score
    const merged = Array.from(new Set([fid, ...followers, ...following]));

    // 2) Neynar: hydrate users in batches
    const batches = chunk(merged, 100);
    const allUsers: NeynarBulkResp["users"] = [];

    for (const b of batches) {
      const r = await neynarUserBulk(b);
      allUsers.push(...(r.users || []));
    }

    // 3) Filter by score, require lat/lng, then group by rounded coordinates
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

      withLocation++;

      // Grouping key: rounded coords (adjust decimals to change grouping aggressiveness)
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

        // Keep a stable city label; prefer non-"Unknown"
        if (existing.city === "Unknown" && city !== "Unknown") existing.city = city;
      }
    }

    // sort: biggest clusters first, then city name
    const points: PinPoint[] = Array.from(grouped.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.city.localeCompare(b.city);
    });

    return NextResponse.json({
      fid,
      mode,
      minScore,
      limitEach,
      followersCount: followers.length,
      followingCount: following.length,
      hydrated: allUsers.length,
      scoredOk,
      missingScore,
      withLocation,
      count: points.length,
      points,
    });
  } catch (e: any) {
    console.error("api/network error:", e);
    return NextResponse.json({ error: e?.message || "Server error" }, { status: 500 });
  }
}

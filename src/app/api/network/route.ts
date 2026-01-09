import { NextResponse } from "next/server";
import { getNetworkFidsFromHub } from "@/lib/hub";

type NeynarBulkResp = {
  users: Array<{
    fid: number;
    username: string;
    display_name?: string;
    pfp_url?: string;

    // ✅ Neynar score fields
    score?: number;
    experimental?: {
      neynar_user_score?: number; // deprecated but sometimes present
    };

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

type Point = {
  fid: number;
  username: string;
  display_name?: string;
  pfp_url?: string;
  city: string;
  lat: number;
  lng: number;
  score: number;
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

function formatCity(u: NeynarBulkResp["users"][number]) {
  const a = u.profile?.location?.address;
  const parts = [a?.city, a?.state, a?.country].filter(Boolean);
  return parts.length ? parts.join(", ") : "Unknown";
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

async function neynarUserBulk(fids: number[]): Promise<NeynarBulkResp> {
  const apiKey = mustEnv("NEYNAR_API_KEY");

  const url = `https://api.neynar.com/v2/farcaster/user/bulk?fids=${encodeURIComponent(
    fids.join(",")
  )}`;

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      api_key: apiKey,
    } as any,
    cache: "no-store",
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
    throw new Error(`${msg}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  if (!json) throw new Error("Neynar returned empty or non-JSON response");
  return json as NeynarBulkResp;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const fidStr = searchParams.get("fid");
    const fid = fidStr ? Number(fidStr) : NaN;

    if (!fidStr || !Number.isFinite(fid) || fid <= 0) {
      return NextResponse.json({ error: "Missing or invalid fid" }, { status: 400 });
    }

    // caps (safe defaults)
    const limitEachParam = Number(searchParams.get("limitEach") || "500");
    const limitEach = Number.isFinite(limitEachParam) ? limitEachParam : 500;

    // ✅ score threshold
    const minScoreParam = Number(searchParams.get("minScore") || "0.8");
    const minScore = Number.isFinite(minScoreParam) ? minScoreParam : 0.8;

    // 1) Hub: get follower + following FIDs (free)
    const { followers, following } = await getNetworkFidsFromHub(fid, {
      includeFollowers: true,
      includeFollowing: true,
      limitEach,
    });

    // include self so you always try to pin yourself too
    const merged = Array.from(new Set([fid, ...followers, ...following]));

    // 2) Neynar: hydrate in batches (username/pfp/location/score)
    const batches = chunk(merged, 100);
    const allUsers: NeynarBulkResp["users"] = [];

    for (const b of batches) {
      const r = await neynarUserBulk(b);
      allUsers.push(...(r.users || []));
    }

    // 3) Filter: score > minScore + must have lat/lng
    const points: Point[] = [];

    let scoredOk = 0;
    let missingScore = 0;
    let withLocation = 0;

    for (const u of allUsers) {
      const score = getUserScore(u);
      if (score === null) {
        missingScore++;
        continue;
      }
      if (score <= minScore) continue;
      scoredOk++;

      const lat = u.profile?.location?.latitude;
      const lng = u.profile?.location?.longitude;
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      withLocation++;

      points.push({
        fid: u.fid,
        username: u.username,
        display_name: u.display_name,
        pfp_url: u.pfp_url,
        city: formatCity(u),
        lat,
        lng,
        score,
      });
    }

    return NextResponse.json({
      fid,
      minScore,
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

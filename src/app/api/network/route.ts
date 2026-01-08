import { NextResponse } from "next/server";
import { neynarGet } from "@/lib/neynar";
import { geocodeCity } from "@/lib/geocode";

type NeynarUser = {
  fid: number;
  username: string;
  display_name?: string;
  pfp_url?: string;
  profile?: {
    bio?: { text?: string };
    // some APIs expose location as a field; we’ll probe common shapes safely
    location?: { name?: string };
  };
  // sometimes location comes as a simple string or nested in different places
  location?: string;

  // NEW: some contexts/APIs may provide location as an object
  // (we keep it loose so we don't break if present)
  locationObj?: { description?: string } | any;
};

type NeynarPage = {
  users: NeynarUser[];
  next?: { cursor?: string };
};

type Point = {
  fid: number;
  username: string;
  display_name?: string;
  pfp_url?: string;
  city: string;
  lat: number;
  lng: number;
};

function extractCity(u: NeynarUser): string | null {
  // 1) Common Neynar nested shape
  const fromNested = u.profile?.location?.name?.trim();
  if (fromNested) return fromNested;

  // 2) Sometimes location is a string
  const fromTop = typeof u.location === "string" ? u.location.trim() : "";
  if (fromTop) return fromTop;

  // 3) If something like { location: { description: "City, ST, Country" } } exists
  const fromObj =
    typeof (u as any)?.location === "object"
      ? String((u as any)?.location?.description || (u as any)?.location?.name || "")
      : "";
  if (fromObj.trim()) return fromObj.trim();

  // (Optional future) parse bio text or verified fields here.
  return null;
}

// OPTIONAL: basic pagination helper (caps pages to avoid runaway)
async function fetchAllUsers(
  endpoint: "followers" | "following",
  fid: number,
  limit = 100,
  maxPages = 3
): Promise<NeynarUser[]> {
  const out: NeynarUser[] = [];
  let cursor: string | undefined = undefined;

  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams();
    qs.set("fid", String(fid));
    qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);

    const data = await neynarGet<NeynarPage>(`/user/${endpoint}?${qs.toString()}`);

    if (Array.isArray(data?.users)) out.push(...data.users);

    cursor = data?.next?.cursor;
    if (!cursor) break;
  }

  return out;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const fid = searchParams.get("fid");

    if (!fid) return NextResponse.json({ error: "Missing fid" }, { status: 400 });

    const fidNum = Number(fid);
    if (!Number.isFinite(fidNum) || fidNum <= 0) {
      return NextResponse.json({ error: "Invalid fid" }, { status: 400 });
    }

    // Toggle pagination on/off via query param: ?pages=1 (default 1) or ?pages=3
    const pagesParam = Number(searchParams.get("pages") || "1");
    const maxPages = Number.isFinite(pagesParam) ? Math.min(Math.max(pagesParam, 1), 5) : 1;

    // Followers + Following (paged)
    const [followersUsers, followingUsers] = await Promise.all([
      fetchAllUsers("followers", fidNum, 100, maxPages),
      fetchAllUsers("following", fidNum, 100, maxPages),
    ]);

    // Merge + dedupe by fid
    const merged = new Map<number, NeynarUser>();
    for (const u of [...followersUsers, ...followingUsers]) merged.set(u.fid, u);

    // Debug counters
    let withCity = 0;
    let geocodeSuccess = 0;
    let geocodeFail = 0;

    const points: Point[] = [];

    for (const u of merged.values()) {
      const city = extractCity(u);
      if (!city) continue;
      withCity++;

      const geo = await geocodeCity(city);
      if (!geo) {
        geocodeFail++;
        continue;
      }

      // ✅ Normalize to lng (your old code used geo.lon)
      const lat = Number((geo as any).lat);
      const lng = Number((geo as any).lng ?? (geo as any).lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        geocodeFail++;
        continue;
      }

      geocodeSuccess++;

      points.push({
        fid: u.fid,
        username: u.username,
        display_name: u.display_name,
        pfp_url: u.pfp_url,
        city,
        lat,
        lng,
      });
    }

    return NextResponse.json({
      fid: fidNum,
      pages: maxPages,
      followers: followersUsers.length,
      following: followingUsers.length,
      totalUsers: merged.size,
      withCity,
      geocodeSuccess,
      geocodeFail,
      count: points.length,
      points,
    });
  } catch (e: any) {
    console.error("api/network error:", e);
    return NextResponse.json(
      { error: e?.message || "Server error" },
      { status: 500 }
    );
  }
}

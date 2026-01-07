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
};

function extractCity(u: NeynarUser): string | null {
  // Try multiple possible shapes without assuming exact schema
  const fromNested = u.profile?.location?.name?.trim();
  if (fromNested) return fromNested;

  const fromTop = typeof u.location === "string" ? u.location.trim() : "";
  if (fromTop) return fromTop;

  // If you later decide to read it from bio text or a verified field, do it here.
  return null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const fid = searchParams.get("fid");
  if (!fid) return NextResponse.json({ error: "Missing fid" }, { status: 400 });

  const fidNum = Number(fid);
  if (!Number.isFinite(fidNum)) return NextResponse.json({ error: "Invalid fid" }, { status: 400 });

  // Followers
  const followers = await neynarGet<{
    users: NeynarUser[];
    next?: { cursor?: string };
  }>(`/user/followers?fid=${fidNum}&limit=100`);

  // Following
  const following = await neynarGet<{
    users: NeynarUser[];
    next?: { cursor?: string };
  }>(`/user/following?fid=${fidNum}&limit=100`);

  // Merge + dedupe by fid
  const merged = new Map<number, NeynarUser>();
  for (const u of [...followers.users, ...following.users]) merged.set(u.fid, u);

  // Convert to points by city
  const points: Array<{
    fid: number;
    username: string;
    display_name?: string;
    pfp_url?: string;
    city: string;
    lat: number;
    lng: number;
  }> = [];

  for (const u of merged.values()) {
    const city = extractCity(u);
    if (!city) continue;

    const geo = await geocodeCity(city);
    if (!geo) continue;

    points.push({
      fid: u.fid,
      username: u.username,
      display_name: u.display_name,
      pfp_url: u.pfp_url,
      city,
      lat: geo.lat,
      lng: geo.lon
    });
  }

  return NextResponse.json({
    fid: fidNum,
    count: points.length,
    points
  });
}

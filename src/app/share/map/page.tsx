"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { ComponentType } from "react";

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

// ✅ Type the dynamic import so ShareMapInner accepts props
const ShareMapInner = dynamic(
  () => import("./share-map-inner").then((m) => m.default),
  { ssr: false }
) as ComponentType<{ points: PinPoint[]; ready: boolean }>;

export default function ShareMapPage() {
  const [points, setPoints] = useState<PinPoint[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const fid = sp.get("fid");
    const mode = sp.get("mode") || "followers";
    const minScore = sp.get("minScore") || "0.8";
    const limitEach = sp.get("limitEach") || "all";
    const maxEach = sp.get("maxEach") || "20000";

    if (!fid) return;

    const url =
      `/api/network?fid=${encodeURIComponent(fid)}` +
      `&mode=${encodeURIComponent(mode)}` +
      `&minScore=${encodeURIComponent(minScore)}` +
      `&limitEach=${encodeURIComponent(limitEach)}` +
      `&maxEach=${encodeURIComponent(maxEach)}`;

    (async () => {
      const res = await fetch(url, { cache: "no-store" });
      const text = await res.text();

      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      setPoints(Array.isArray(json?.points) ? json.points : []);
      setReady(true);
    })();
  }, []);

  return (
    <div
      id="share-map-root"
      style={{
        width: "100vw",
        height: "100vh",
        margin: 0,
        padding: 0,
        overflow: "hidden",
        background: "#000",
      }}
    >
      <ShareMapInner points={points} ready={ready} />
    </div>
  );
}

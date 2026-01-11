"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
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
) as ComponentType<{
  points: PinPoint[];
  ready: boolean;
  imageUrl: string;
  homeUrl: string;
}>;

export default function ShareMapPage() {
  const [points, setPoints] = useState<PinPoint[]>([]);
  const [ready, setReady] = useState(false);

  // Read query params once
  const params = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    const fid = sp.get("fid") || "";
    const mode = sp.get("mode") || "both";
    const minScore = sp.get("minScore") || "0.8";
    const limitEach = sp.get("limitEach") || "800";
    const maxEach = sp.get("maxEach") || "5000";
    const w = sp.get("w") || "1000";
    const h = sp.get("h") || "1000";

    return { fid, mode, minScore, limitEach, maxEach, w, h };
  }, []);

  // ✅ This is the URL we will embed in the cast (image URL)
  const imageUrl = useMemo(() => {
    const { fid, mode, minScore, limitEach, maxEach, w, h } = params;
    if (!fid) return "";

    return (
      `${window.location.origin}/api/map-image` +
      `?fid=${encodeURIComponent(fid)}` +
      `&mode=${encodeURIComponent(mode)}` +
      `&minScore=${encodeURIComponent(minScore)}` +
      `&limitEach=${encodeURIComponent(limitEach)}` +
      `&maxEach=${encodeURIComponent(maxEach)}` +
      `&w=${encodeURIComponent(w)}` +
      `&h=${encodeURIComponent(h)}`
    );
  }, [params]);

  // Home should go to main page
  const homeUrl = useMemo(() => `${window.location.origin}/`, []);

  useEffect(() => {
    const { fid, mode, minScore, limitEach, maxEach } = params;
    if (!fid) return;

    const url =
      `/api/network?fid=${encodeURIComponent(fid)}` +
      `&mode=${encodeURIComponent(mode)}` +
      `&minScore=${encodeURIComponent(minScore)}` +
      `&limitEach=${encodeURIComponent(limitEach)}` +
      `&maxEach=${encodeURIComponent(maxEach)}`;

    (async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        const text = await res.text();

        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }

        setPoints(Array.isArray(json?.points) ? json.points : []);
      } finally {
        setReady(true);
      }
    })();
  }, [params]);

  return (
    <div
      id="share-map-root"
      style={{
        width: "100vw",
        height: "100vh",
        margin: 0,
        padding: 0,
        overflow: "hidden",
        background: "#000", // this can be overridden in inner page styling
      }}
    >
      <ShareMapInner points={points} ready={ready} imageUrl={imageUrl} homeUrl={homeUrl} />
    </div>
  );
}

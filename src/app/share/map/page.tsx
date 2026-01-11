"use client";

export const dynamic = "force-dynamic"; // ✅ prevents static prerender
export const revalidate = 0;

import dynamicImport from "next/dynamic";
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

const ShareMapInner = dynamicImport(
  () => import("./share-map-inner").then((m) => m.default),
  { ssr: false }
) as ComponentType<{
  points: PinPoint[];
  ready: boolean;
  imageUrl: string;
  homeUrl: string;
  renderOnly: boolean;
}>;

export default function ShareMapPage() {
  const [points, setPoints] = useState<PinPoint[]>([]);
  const [ready, setReady] = useState(false);

  // ✅ do NOT use window in useMemo during render
  const [renderOnly, setRenderOnly] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [homeUrl, setHomeUrl] = useState("");
  const [networkUrl, setNetworkUrl] = useState("");

  useEffect(() => {
    // ✅ safe: runs only on client
    const sp = new URLSearchParams(window.location.search);
    const fid = sp.get("fid") || "";
    const mode = sp.get("mode") || "both";
    const minScore = sp.get("minScore") || "0.8";
    const limitEach = sp.get("limitEach") || "800";
    const maxEach = sp.get("maxEach") || "5000";
    const w = sp.get("w") || "1000";
    const h = sp.get("h") || "1000";
    const ro = sp.get("renderOnly") === "1";

    setRenderOnly(ro);
    setHomeUrl(`${window.location.origin}/`);

    if (!fid) {
      setReady(true);
      return;
    }

    const base = window.location.origin;

    setNetworkUrl(
      `/api/network?fid=${encodeURIComponent(fid)}` +
        `&mode=${encodeURIComponent(mode)}` +
        `&minScore=${encodeURIComponent(minScore)}` +
        `&limitEach=${encodeURIComponent(limitEach)}` +
        `&maxEach=${encodeURIComponent(maxEach)}`
    );

    setImageUrl(
      `${base}/api/map-image` +
        `?fid=${encodeURIComponent(fid)}` +
        `&mode=${encodeURIComponent(mode)}` +
        `&minScore=${encodeURIComponent(minScore)}` +
        `&limitEach=${encodeURIComponent(limitEach)}` +
        `&maxEach=${encodeURIComponent(maxEach)}` +
        `&w=${encodeURIComponent(w)}` +
        `&h=${encodeURIComponent(h)}`
    );
  }, []);

  useEffect(() => {
    if (!networkUrl) return;

    (async () => {
      try {
        const res = await fetch(networkUrl, { cache: "no-store" });
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
  }, [networkUrl]);

  return (
    <div
      id="share-map-root"
      style={{
        width: "100vw",
        height: "100vh",
        margin: 0,
        padding: 0,
        overflow: "hidden",
        background: "#c7b3ff",
      }}
    >
      <ShareMapInner
        points={points}
        ready={ready}
        imageUrl={imageUrl}
        homeUrl={homeUrl}
        renderOnly={renderOnly}
      />
    </div>
  );
}

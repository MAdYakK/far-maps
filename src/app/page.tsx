"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { LatLngExpression } from "leaflet";
import { sdk } from "@farcaster/miniapp-sdk";
import type { Point } from "@/components/LeafletMap";

// ✅ Leaflet loads ONLY in the browser (prevents Vercel "window is not defined")
const LeafletMap = dynamic(
  () => import("@/components/LeafletMap").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "grid",
          placeItems: "center",
        }}
      >
        Loading map…
      </div>
    ),
  }
) as ComponentType<{
  center: LatLngExpression;
  zoom: number;
  points: Point[];
}>;

export default function HomePage() {
  const [fid, setFid] = useState<number | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
  (async () => {
    try {
      const ctx = await sdk.context;
      const viewerFid = (ctx as any)?.viewer?.fid as number | undefined;
      if (viewerFid) setFid(viewerFid);
    } catch {
      // normal browser: no fid
    } finally {
      // ✅ Tell Warpcast the mini app is ready (prevents splash screen persisting)
      try {
        await sdk.actions.ready();
      } catch {
        // ignore if not running inside Farcaster
      }
    }
  })();
}, []);


  useEffect(() => {
    if (!fid) return;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/network?fid=${fid}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Failed to load network");
        setPoints(json.points || []);
      } catch (e: any) {
        setError(e?.message || "Unknown error");
      } finally {
        setLoading(false);
      }
    })();
  }, [fid]);

  const center = useMemo<LatLngExpression>(() => {
    if (points.length) return [points[0].lat, points[0].lng];
    return [39.5, -98.35]; // US-ish default
  }, [points]);

  return (
    <main style={{ height: "100vh", width: "100vw" }}>
      <div
        style={{
          position: "absolute",
          zIndex: 1000,
          top: 12,
          left: 12,
          padding: 10,
          borderRadius: 12,
          background: "rgba(0,0,0,0.55)",
          color: "white",
          maxWidth: 320,
        }}
      >
        <div style={{ fontWeight: 700 }}>
          {process.env.NEXT_PUBLIC_APP_NAME || "Far Maps"}
        </div>
        <div style={{ fontSize: 12, opacity: 0.9 }}>
          Followers + Following by city
        </div>
        <div style={{ marginTop: 8, fontSize: 12 }}>
          {fid ? (
            <>Viewer FID: {fid}</>
            
          ) : (
            <>Open inside Warpcast to load your network.</>
          )}
        </div>
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
  {fid ? `Loading from /api/network?fid=${fid}` : "No FID (must open inside Warpcast)"}
</div>

        <div style={{ marginTop: 6, fontSize: 12 }}>
          {loading ? "Loading…" : `Pins: ${points.length}`}
        </div>
        {error && (
          <div style={{ marginTop: 6, fontSize: 12, color: "#ffb4b4" }}>
            {error}
          </div>
        )}
      </div>

      <div style={{ height: "100%", width: "100%" }}>
        <LeafletMap center={center} zoom={points.length ? 3 : 4} points={points} />
      </div>
    </main>
  );
}

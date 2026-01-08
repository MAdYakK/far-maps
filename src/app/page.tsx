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

  // ✅ UI debug for mobile / no-devtools environments
  const [ctxJson, setCtxJson] = useState<string>("");
  const [ctxStatus, setCtxStatus] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        setCtxStatus("Calling sdk.actions.ready()…");
        // IMPORTANT: some environments don’t populate context until ready()
        await sdk.actions.ready();

        setCtxStatus("Fetching sdk.context…");
        const ctx = await sdk.context;

        // show context in UI so we can debug on mobile
        setCtxJson(JSON.stringify(ctx, null, 2));

        const viewerFid = (ctx as any)?.viewer?.fid as number | undefined;
        if (viewerFid) {
          setFid(viewerFid);
          setCtxStatus(`Got viewer fid: ${viewerFid}`);
        } else {
          setCtxStatus("No viewer.fid in context");
        }

        console.log("MINIAPP_CONTEXT", ctx);
      } catch (e: any) {
        console.log("MINIAPP_CONTEXT_ERROR", e);
        setCtxStatus(`Context error: ${e?.message || String(e)}`);
        // normal browser / not launched as mini app / sdk not available
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
          maxWidth: 360,
        }}
      >
        <div style={{ fontWeight: 700 }}>
          {process.env.NEXT_PUBLIC_APP_NAME || "Far Maps"}
        </div>
        <div style={{ fontSize: 12, opacity: 0.9 }}>
          Followers + Following by city
        </div>

        <div style={{ marginTop: 8, fontSize: 12 }}>
          {fid ? <>Viewer FID: {fid}</> : <>Open inside Warpcast to load your network.</>}
        </div>

        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
          {fid ? `Loading from /api/network?fid=${fid}` : "No FID (must open inside Warpcast)"}
        </div>

        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
          {ctxStatus || ""}
        </div>

        <div style={{ marginTop: 6, fontSize: 12 }}>
          {loading ? "Loading…" : `Pins: ${points.length}`}
        </div>

        {error && (
          <div style={{ marginTop: 6, fontSize: 12, color: "#ffb4b4" }}>
            {error}
          </div>
        )}

        {ctxJson ? (
          <pre
            style={{
              marginTop: 8,
              fontSize: 10,
              maxHeight: 160,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              background: "rgba(255,255,255,0.06)",
              padding: 8,
              borderRadius: 10,
            }}
          >
            {ctxJson}
          </pre>
        ) : null}
      </div>

      <div style={{ height: "100%", width: "100%" }}>
        <LeafletMap center={center} zoom={points.length ? 3 : 4} points={points} />
      </div>
    </main>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import type { LatLngExpression } from "leaflet";
import { sdk } from "@farcaster/miniapp-sdk";
import type { PinPoint } from "@/components/LeafletMap";

// 🔧 Toggle debug UI here
const DEBUG = false;

type Mode = "followers" | "following" | "both";

type NetworkResponse = {
  fid: number;
  mode: Mode;
  minScore: number;
  limitEach: string | number;
  maxEach?: number;
  followersCount: number;
  followingCount: number;
  hydrated: number;
  scoredOk: number;
  missingScore: number;
  withLocation: number;
  count: number;
  points: PinPoint[];
  cache?: {
    network?: { hit?: boolean };
    users?: { requested?: number; cacheHits?: number; fetchedCount?: number };
  };
};

const LeafletMap = dynamic(
  () => import("@/components/LeafletMap").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div style={{ height: "100%", width: "100%", display: "grid", placeItems: "center" }}>
        Loading map…
      </div>
    ),
  }
) as ComponentType<{
  center: LatLngExpression;
  zoom: number;
  points: PinPoint[];
}>;

export default function HomePage() {
  const [fid, setFid] = useState<number | null>(null);
  const [points, setPoints] = useState<PinPoint[]>([]);
  const [stats, setStats] = useState<NetworkResponse | null>(null);
  const [mode, setMode] = useState<Mode>("both");

  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const [ctxJson, setCtxJson] = useState<string>("");
  const [ctxStatus, setCtxStatus] = useState<string>("");

  // ✅ overlay minimize state
  const [overlayMin, setOverlayMin] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // ─────────────────────────────────────────────
  // Get Farcaster context + FID
  // ─────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        if (DEBUG) setCtxStatus("Calling sdk.actions.ready()…");
        await sdk.actions.ready();

        const ctx = await sdk.context;
        if (DEBUG) setCtxJson(JSON.stringify(ctx, null, 2));

        const detectedFid =
          ((ctx as any)?.viewer?.fid as number | undefined) ??
          ((ctx as any)?.user?.fid as number | undefined);

        if (detectedFid) {
          setFid(detectedFid);
        }
      } catch (e: any) {
        if (DEBUG) setCtxStatus(e?.message || String(e));
      }
    })();
  }, []);

  // ─────────────────────────────────────────────
  // Fetch network data
  // ─────────────────────────────────────────────
  useEffect(() => {
    if (!fid) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      setLoading(true);
      setError(null);
      setStats(null);

      setLoadingStage(
        mode === "followers"
          ? "Fetching followers…"
          : mode === "following"
          ? "Fetching following…"
          : "Fetching followers + following…"
      );

      try {
        const limitEach = 2000;
        const maxEach = 5000;
        const minScore = 0.8;
        const concurrency = 4;
        const hubPageSize = 50;
        const hubDelayMs = 150;

        const url =
          `/api/network?fid=${fid}` +
          `&mode=${mode}` +
          `&limitEach=${limitEach}` +
          `&maxEach=${maxEach}` +
          `&minScore=${minScore}` +
          `&concurrency=${concurrency}` +
          `&hubPageSize=${hubPageSize}` +
          `&hubDelayMs=${hubDelayMs}`;

        const res = await fetch(url, { signal: controller.signal });
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;

        if (!res.ok || !json) throw new Error("Network error");

        setPoints(json.points || []);
        setStats(json);
      } catch (e: any) {
        if (e?.name !== "AbortError") setError(e?.message || "Error");
      } finally {
        setLoading(false);
        setLoadingStage("");
      }
    })();

    return () => controller.abort();
  }, [fid, mode]);

  const center = useMemo<LatLngExpression>(() => {
    if (points.length) return [points[0].lat, points[0].lng];
    return [20, 0];
  }, [points]);

  const shareUrl = useMemo(() => {
    if (!fid) return "";
    const qs =
      `fid=${fid}` +
      `&mode=${mode}` +
      `&minScore=0.8` +
      `&limitEach=800` +
      `&maxEach=5000` +
      `&concurrency=4` +
      `&hubPageSize=50` +
      `&hubDelayMs=150`;
    return `/share/map?${qs}`;
  }, [fid, mode]);

  // We’ll use a simple, readable minimize/maximize icon:
  // ▾ (collapse) / ▴ (expand)
  const MinIcon = overlayMin ? "▴" : "▾";

  return (
    <main style={{ height: "100vh", width: "100vw" }}>
      {/* ✅ Move Leaflet zoom controls slightly right from the edge (still on the left) */}
      <style jsx global>{`
        /* Keep zoom controls on LEFT, but nudge them right a bit */
        .leaflet-top.leaflet-left {
          left: 12px;
          top: 12px;
        }
        .leaflet-left .leaflet-control {
          margin-left: 0;
        }
        .leaflet-top .leaflet-control {
          margin-top: 0;
        }
      `}</style>

      {/* UI Overlay */}
      <div
        style={{
          position: "absolute",
          zIndex: 1000,
          top: 12,
          // ✅ sits to the right of the zoom controls area
          left: 56,
          padding: overlayMin ? 8 : 10,
          borderRadius: overlayMin ? 999 : 12,
          background: "rgba(0,0,0,0.55)",
          color: "white",
          maxWidth: overlayMin ? 220 : 420,
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: overlayMin ? "pointer" : "default",
          userSelect: "none",
        }}
        onClick={() => {
          if (overlayMin) setOverlayMin(false);
        }}
      >
        {/* Left side: title */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 800, lineHeight: 1 }}>{overlayMin ? "Far Maps" : "Far Maps"}</div>

            {/* Minimize / maximize button (always visible) */}
            <button
              type="button"
              aria-label={overlayMin ? "Expand" : "Minimize"}
              onClick={(e) => {
                e.stopPropagation();
                setOverlayMin((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                width: 28,
                height: 28,
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.22)",
                background: "rgba(255,255,255,0.10)",
                color: "white",
                cursor: "pointer",
                fontWeight: 900,
                lineHeight: "26px",
                padding: 0,
              }}
              title={overlayMin ? "Expand" : "Minimize"}
            >
              {MinIcon}
            </button>
          </div>

          {/* Expanded content */}
          {!overlayMin ? (
            <>
              <div style={{ marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <ToggleButton active={mode === "following"} onClick={() => setMode("following")}>
                  Following
                </ToggleButton>
                <ToggleButton active={mode === "followers"} onClick={() => setMode("followers")}>
                  Followers
                </ToggleButton>
                <ToggleButton active={mode === "both"} onClick={() => setMode("both")}>
                  Both
                </ToggleButton>

                {/* ✅ SHARE BUTTON */}
                <ToggleButton
                  active={false}
                  onClick={() => {
                    if (!fid) return;
                    window.location.href = shareUrl;
                  }}
                >
                  Share
                </ToggleButton>
              </div>

              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9 }}>
                {fid ? `FID: ${fid}` : "Open inside Warpcast"}
              </div>

              {error && <div style={{ marginTop: 6, fontSize: 12, color: "#ffb4b4" }}>{error}</div>}
            </>
          ) : null}
        </div>
      </div>

      {/* Loading overlay */}
      {loading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 2000,
            background: "rgba(0,0,0,0.35)",
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
          }}
        >
          <div style={{ color: "white", fontWeight: 700 }}>{loadingStage || "Loading…"}</div>
        </div>
      )}

      {/* Map */}
      <div style={{ height: "100%", width: "100%" }}>
        <LeafletMap center={center} zoom={points.length ? 3 : 2} points={points} />
      </div>
    </main>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation(); // ✅ don’t toggle overlay when clicking buttons
        onClick();
      }}
      type="button"
      style={{
        border: "1px solid rgba(255,255,255,0.22)",
        background: active ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.06)",
        color: "white",
        padding: "6px 10px",
        borderRadius: 999,
        fontSize: 12,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {children}
    </button>
  );
}

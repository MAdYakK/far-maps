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
        } else {
          if (DEBUG) setCtxStatus("No FID found in context.");
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
        // Your current settings
        const limitEach = 10000;
        const maxEach = 20000;
        const minScore = 0.8;
        const concurrency = 2;
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

        // Optional “step” update (feels nicer)
        setLoadingStage("Hydrating profiles…");

        const text = await res.text();
        const json = text ? JSON.parse(text) : null;

        if (!res.ok || !json) throw new Error("Network error");

        setLoadingStage("Building pins…");

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

  // Simple, readable minimize/maximize icon:
  // ▾ (collapse) / ▴ (expand)
  const MinIcon = overlayMin ? "▴" : "▾";

  return (
    <main style={{ height: "100vh", width: "100vw" }}>
      {/* ✅ Keep zoom controls on LEFT, but nudge them right a bit */}
      <style jsx global>{`
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
          left: 56, // sits to the right of the zoom controls
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
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 800, lineHeight: 1 }}>Far Maps</div>

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

              {DEBUG ? (
                <div style={{ marginTop: 10, fontSize: 11, opacity: 0.9 }}>
                  <div style={{ fontWeight: 800, marginBottom: 4 }}>Debug</div>
                  {ctxStatus ? <div style={{ marginBottom: 6 }}>ctxStatus: {ctxStatus}</div> : null}
                  {stats ? (
                    <div style={{ marginBottom: 6 }}>
                      followers: {stats.followersCount} • following: {stats.followingCount} • pins:{" "}
                      {stats.count}
                    </div>
                  ) : null}
                  {ctxJson ? (
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 140,
                        overflow: "auto",
                        background: "rgba(255,255,255,0.08)",
                        padding: 8,
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.12)",
                      }}
                    >
                      {ctxJson}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {/* ✅ Loading overlay with text + loading bar */}
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
            padding: 16,
          }}
        >
          <div
            style={{
              width: "min(520px, 92vw)",
              borderRadius: 16,
              background: "rgba(0,0,0,0.55)",
              border: "1px solid rgba(255,255,255,0.18)",
              boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
              color: "white",
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 14 }}>{loadingStage || "Loading…"}</div>

            <div style={{ marginTop: 10 }}>
              {/* Indeterminate bar */}
              <div
                style={{
                  position: "relative",
                  height: 10,
                  borderRadius: 999,
                  overflow: "hidden",
                  background: "rgba(255,255,255,0.14)",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    width: "40%",
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.70)",
                    animation: "farmapsBar 1.05s ease-in-out infinite",
                  }}
                />
              </div>

              {/* Little spinner row */}
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, opacity: 0.95 }}>
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 999,
                    border: "2px solid rgba(255,255,255,0.25)",
                    borderTopColor: "white",
                    animation: "farmapsSpin 0.85s linear infinite",
                  }}
                />
                <div style={{ fontSize: 12, opacity: 0.9 }}>Please wait…</div>
              </div>
            </div>

            <style jsx global>{`
              @keyframes farmapsBar {
                0% {
                  left: -40%;
                }
                50% {
                  left: 30%;
                }
                100% {
                  left: 100%;
                }
              }
              @keyframes farmapsSpin {
                to {
                  transform: rotate(360deg);
                }
              }
            `}</style>
          </div>
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

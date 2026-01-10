"use client";

import { useEffect, useMemo, useState } from "react";
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
  limitEach: number;
  followersCount: number;
  followingCount: number;
  hydrated: number;
  scoredOk: number;
  missingScore: number;
  withLocation: number;
  count: number; // number of grouped pins
  points: PinPoint[];
};

// ✅ Leaflet loads ONLY in browser (prevents SSR issues)
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
  points: PinPoint[];
}>;

export default function HomePage() {
  const [fid, setFid] = useState<number | null>(null);

  // grouped pins now
  const [points, setPoints] = useState<PinPoint[]>([]);
  const [stats, setStats] = useState<NetworkResponse | null>(null);

  const [mode, setMode] = useState<Mode>("both");

  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // Debug-only state
  const [ctxJson, setCtxJson] = useState<string>("");
  const [ctxStatus, setCtxStatus] = useState<string>("");

  // ─────────────────────────────────────────────
  // Get Farcaster context + FID
  // ─────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        if (DEBUG) setCtxStatus("Calling sdk.actions.ready()…");
        await sdk.actions.ready();

        if (DEBUG) setCtxStatus("Fetching sdk.context…");
        const ctx = await sdk.context;

        if (DEBUG) setCtxJson(JSON.stringify(ctx, null, 2));

        const detectedFid =
          ((ctx as any)?.viewer?.fid as number | undefined) ??
          ((ctx as any)?.user?.fid as number | undefined);

        if (detectedFid) {
          setFid(detectedFid);
          if (DEBUG) setCtxStatus(`Got fid: ${detectedFid}`);
        } else {
          if (DEBUG) setCtxStatus("No fid in context");
        }

        if (DEBUG) console.log("MINIAPP_CONTEXT", ctx);
      } catch (e: any) {
        if (DEBUG) {
          console.log("MINIAPP_CONTEXT_ERROR", e);
          setCtxStatus(`Context error: ${e?.message || String(e)}`);
        }
      }
    })();
  }, []);

  // ─────────────────────────────────────────────
  // Fetch network data (mode toggle)
  // ─────────────────────────────────────────────
  useEffect(() => {
    if (!fid) return;

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
        const limitEach = 5000; // tune
        const minScore = 0.7;

        const url = `/api/network?fid=${fid}&mode=${mode}&limitEach=${limitEach}&minScore=${minScore}`;

        const res = await fetch(url, { cache: "no-store" });

        // ✅ Avoid "Unexpected end of JSON input"
        const text = await res.text();

        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }

        if (!res.ok) {
          const msg =
            json?.error ||
            `API error ${res.status} ${res.statusText}${
              text ? ` — ${text.slice(0, 200)}` : ""
            }`;
          throw new Error(msg);
        }

        if (!json) throw new Error("API returned empty or non-JSON response");

        setLoadingStage("Rendering map…");

        setPoints(Array.isArray(json.points) ? json.points : []);
        setStats(json as NetworkResponse);
      } catch (e: any) {
        setError(
          `${e?.message || "Unknown error"}${
            e?.cause?.message ? ` — ${e.cause.message}` : ""
          }`
        );
        setPoints([]);
        setStats(null);
      } finally {
        setLoading(false);
        setLoadingStage("");
      }
    })();
  }, [fid, mode]);

  const center = useMemo<LatLngExpression>(() => {
    if (points.length) return [points[0].lat, points[0].lng];
    return [39.5, -98.35];
  }, [points]);

  const pinCount = points.length;
  const userCount = points.reduce((acc, p) => acc + (p.users?.length || 0), 0);

  return (
    <main style={{ height: "100vh", width: "100vw" }}>
      {/* ───────── UI Overlay ───────── */}
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
          maxWidth: 420,
        }}
      >
        <div style={{ fontWeight: 700 }}>
          {process.env.NEXT_PUBLIC_APP_NAME || "Far Maps"}
        </div>

        <div style={{ fontSize: 12, opacity: 0.9 }}>
          Followers + Following by location
        </div>

        {/* Toggle */}
        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ToggleButton active={mode === "following"} onClick={() => setMode("following")}>
            Following
          </ToggleButton>
          <ToggleButton active={mode === "followers"} onClick={() => setMode("followers")}>
            Followers
          </ToggleButton>
          <ToggleButton active={mode === "both"} onClick={() => setMode("both")}>
            Both
          </ToggleButton>
        </div>

        <div style={{ marginTop: 8, fontSize: 12 }}>
          {fid ? <>FID: {fid}</> : <>Open inside Warpcast to load your network.</>}
        </div>

        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
          {fid ? `Mode: ${mode} • Pins: ${pinCount} • Users: ${userCount}` : "No FID"}
        </div>

        {stats ? (
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
            Hub: followers {stats.followersCount} • following {stats.followingCount} •
            hydrated {stats.hydrated} • score&gt;{stats.minScore} {stats.scoredOk} •
            loc {stats.withLocation}
          </div>
        ) : null}

        <div style={{ marginTop: 6, fontSize: 12 }}>
          {loading ? "Loading…" : `Pins: ${pinCount}`}
        </div>

        {error && (
          <div style={{ marginTop: 6, fontSize: 12, color: "#ffb4b4" }}>
            {error}
          </div>
        )}

        {/* ───────── DEBUG ONLY ───────── */}
        {DEBUG && (
          <>
            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
              {ctxStatus}
            </div>

            {ctxJson && (
              <pre
                style={{
                  marginTop: 8,
                  fontSize: 10,
                  maxHeight: 170,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  background: "rgba(255,255,255,0.06)",
                  padding: 8,
                  borderRadius: 10,
                }}
              >
                {ctxJson}
              </pre>
            )}
          </>
        )}
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
          <div
            style={{
              width: 340,
              borderRadius: 16,
              background: "rgba(0,0,0,0.65)",
              color: "white",
              padding: 14,
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  border: "3px solid rgba(255,255,255,0.25)",
                  borderTopColor: "white",
                  animation: "spin 0.9s linear infinite",
                }}
              />
              <div style={{ fontWeight: 700 }}>Loading Far Maps</div>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>
              {loadingStage || "Loading…"}
            </div>

            <div
              style={{
                marginTop: 10,
                height: 8,
                background: "rgba(255,255,255,0.15)",
                borderRadius: 999,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: stats
                    ? `${Math.min(
                        100,
                        Math.round((stats.withLocation / Math.max(1, stats.hydrated)) * 100)
                      )}%`
                    : "35%",
                  background: "rgba(255,255,255,0.85)",
                }}
              />
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>
              {stats ? (
                <>
                  Hydrated: {stats.hydrated} • Score&gt;{stats.minScore}: {stats.scoredOk} •
                  Pins: {pinCount} • Users: {userCount}
                </>
              ) : (
                <>Starting…</>
              )}
            </div>
          </div>

          <style jsx global>{`
            @keyframes spin {
              to {
                transform: rotate(360deg);
              }
            }
          `}</style>
        </div>
      )}

      {/* Map */}
      <div style={{ height: "100%", width: "100%" }}>
        <LeafletMap center={center} zoom={points.length ? 3 : 4} points={points} />
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
      onClick={onClick}
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

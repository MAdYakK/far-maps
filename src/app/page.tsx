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

  const [points, setPoints] = useState<PinPoint[]>([]);
  const [stats, setStats] = useState<NetworkResponse | null>(null);

  const [mode, setMode] = useState<Mode>("both");

  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // Debug-only state
  const [ctxJson, setCtxJson] = useState<string>("");
  const [ctxStatus, setCtxStatus] = useState<string>("");

  // Abort in-flight requests (prevents piling up + rate limiting)
  const abortRef = useRef<AbortController | null>(null);

  // Share button state
  const [sharing, setSharing] = useState(false);

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

    // cancel any previous request
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
        // ✅ SAFE DEFAULTS (avoid hammering Pinata hub)
        const limitEach = 800; // per side
        const maxEach = 5000; // safety cap if you ever switch to "all"
        const minScore = 0.8;
        const concurrency = 4;

        // Hub pacing knobs (these help a ton on pinata)
        const hubPageSize = 50;
        const hubDelayMs = 150;

        const url =
          `/api/network?fid=${fid}` +
          `&mode=${mode}` +
          `&limitEach=${encodeURIComponent(String(limitEach))}` +
          `&maxEach=${encodeURIComponent(String(maxEach))}` +
          `&minScore=${encodeURIComponent(String(minScore))}` +
          `&concurrency=${encodeURIComponent(String(concurrency))}` +
          `&hubPageSize=${encodeURIComponent(String(hubPageSize))}` +
          `&hubDelayMs=${encodeURIComponent(String(hubDelayMs))}`;

        const res = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });

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
        // Ignore abort errors (toggle spamming)
        if (e?.name === "AbortError") return;

        setError(e?.message || "Unknown error");
        setPoints([]);
        setStats(null);
      } finally {
        setLoading(false);
        setLoadingStage("");
      }
    })();

    return () => {
      controller.abort();
    };
  }, [fid, mode]);

  const center = useMemo<LatLngExpression>(() => {
    if (points.length) return [points[0].lat, points[0].lng];
    return [39.5, -98.35];
  }, [points]);

  const pinCount = points.length;
  const userCount = points.reduce((acc, p) => acc + (p.users?.length || 0), 0);

  // ─────────────────────────────────────────────
  // Share: open your share page
  // ─────────────────────────────────────────────
  async function openSharePage() {
    if (!fid) {
      setError("No FID yet — open inside Warpcast.");
      return;
    }

    try {
      setSharing(true);
      setError(null);

      // Keep these in sync with the fetch tunables above
      const limitEach = 800;
      const maxEach = 5000;
      const minScore = 0.8;
      const concurrency = 4;
      const hubPageSize = 50;
      const hubDelayMs = 150;

      // 👇 Change this to whatever route your share page uses.
      // If your share page is at /share, this is correct.
      const sharePath = "/share/map";

      const shareUrl =
        `${window.location.origin}${sharePath}` +
        `?fid=${encodeURIComponent(String(fid))}` +
        `&mode=${encodeURIComponent(mode)}` +
        `&limitEach=${encodeURIComponent(String(limitEach))}` +
        `&maxEach=${encodeURIComponent(String(maxEach))}` +
        `&minScore=${encodeURIComponent(String(minScore))}` +
        `&concurrency=${encodeURIComponent(String(concurrency))}` +
        `&hubPageSize=${encodeURIComponent(String(hubPageSize))}` +
        `&hubDelayMs=${encodeURIComponent(String(hubDelayMs))}`;

      // Prefer Warpcast openUrl if available
      try {
        await sdk.actions.openUrl(shareUrl);
      } catch {
        // Fallback for normal browser/dev
        window.open(shareUrl, "_blank", "noopener,noreferrer");
      }
    } catch (e: any) {
      setError(e?.message || "Failed to open share page");
    } finally {
      setSharing(false);
    }
  }

  return (
    <main style={{ height: "100vh", width: "100vw" }}>
      {/* UI Overlay */}
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
          maxWidth: 460,
        }}
      >
        <div style={{ fontWeight: 700 }}>
          {process.env.NEXT_PUBLIC_APP_NAME || "Far Maps"}
        </div>

        <div style={{ fontSize: 12, opacity: 0.9 }}>
          Followers + Following by location
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ToggleButton
            active={mode === "following"}
            onClick={() => setMode("following")}
          >
            Following
          </ToggleButton>
          <ToggleButton
            active={mode === "followers"}
            onClick={() => setMode("followers")}
          >
            Followers
          </ToggleButton>
          <ToggleButton active={mode === "both"} onClick={() => setMode("both")}>
            Both
          </ToggleButton>

          {/* ✅ Share button added here */}
          <ToggleButton active={false} onClick={() => openSharePage()}>
            {sharing ? "Opening…" : "Share"}
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

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
    network?: { hitL1?: boolean; hitRedis?: boolean };
    users?: { requested?: number; cacheHitsL1?: number; cacheHitsRedis?: number; fetchedCount?: number };
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

// Tiered expansion steps (safe ramp)
const MAX_EACH_STEPS = [5_000, 10_000, 20_000, 50_000] as const;

function nextStep(curr: number) {
  for (const s of MAX_EACH_STEPS) if (s > curr) return s;
  return curr;
}

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

  const abortRef = useRef<AbortController | null>(null);

  // ─────────────────────────────────────────────
  // Progressive loading state
  // ─────────────────────────────────────────────
  const [maxEach, setMaxEach] = useState<number>(MAX_EACH_STEPS[0]);
  const [autoLoad, setAutoLoad] = useState(false);
  const autoRef = useRef(false);
  autoRef.current = autoLoad;

  // Tune these to “not hammer Neynar”
  // (Your /api/network route already retries/backoffs; these just reduce burst.)
  const limitEach = 2000; // can be higher, but 2k is a good balance
  const minScore = 0.8;
  const concurrency = 2; // <-- key: reduce Neynar parallelism for huge loads
  const hubPageSize = 50;
  const hubDelayMs = 200;

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

        if (detectedFid) setFid(detectedFid);
      } catch (e: any) {
        if (DEBUG) setCtxStatus(e?.message || String(e));
      }
    })();
  }, []);

  // ─────────────────────────────────────────────
  // Fetch network data (tiered maxEach)
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
          ? `Fetching followers (up to ${maxEach.toLocaleString()})…`
          : mode === "following"
          ? `Fetching following (up to ${maxEach.toLocaleString()})…`
          : `Fetching followers + following (up to ${maxEach.toLocaleString()})…`
      );

      try {
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

        if (!res.ok || !json) throw new Error(json?.error || "Network error");

        setPoints(json.points || []);
        setStats(json);

        // If auto-load is on and we likely hit the cap, step up after a short delay
        // (We assume “capped” when returned count == maxEach for the chosen mode.)
        if (autoRef.current) {
          const followerCapHit = (json.followersCount ?? 0) >= maxEach && (mode === "followers" || mode === "both");
          const followingCapHit = (json.followingCount ?? 0) >= maxEach && (mode === "following" || mode === "both");

          const capHit = followerCapHit || followingCapHit;

          const next = nextStep(maxEach);
          if (capHit && next > maxEach) {
            // small delay to spread Neynar/hub load
            await new Promise((r) => setTimeout(r, 900));
            // only continue if still auto-loading
            if (autoRef.current) setMaxEach(next);
          } else {
            // stop auto if no longer capped or no next step
            if (autoRef.current) setAutoLoad(false);
          }
        }
      } catch (e: any) {
        if (e?.name !== "AbortError") {
          setError(e?.message || "Error");
          setAutoLoad(false);
        }
      } finally {
        setLoading(false);
        setLoadingStage("");
      }
    })();

    return () => controller.abort();
  }, [fid, mode, maxEach]);

  const center = useMemo<LatLngExpression>(() => {
    if (points.length) return [points[0].lat, points[0].lng];
    return [20, 0];
  }, [points]);

  // Decide whether to show “Load more”
  const canLoadMore = useMemo(() => {
    if (!stats) return false;

    const followerCapHit =
      (stats.followersCount ?? 0) >= maxEach && (mode === "followers" || mode === "both");
    const followingCapHit =
      (stats.followingCount ?? 0) >= maxEach && (mode === "following" || mode === "both");

    const capHit = followerCapHit || followingCapHit;
    const next = nextStep(maxEach);

    return capHit && next > maxEach;
  }, [stats, mode, maxEach]);

  const maxEachLabel = useMemo(() => {
    return `Max: ${maxEach.toLocaleString()}`;
  }, [maxEach]);

  return (
    <main style={{ height: "100vh", width: "100vw" }}>
      {/* UI Overlay */}
      <div
        style={{
          position: "absolute",
          zIndex: 1000,
          top: 12,
          left: 56,
          padding: 10,
          borderRadius: 12,
          background: "rgba(0,0,0,0.55)",
          color: "white",
          maxWidth: 520,
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <div style={{ fontWeight: 800 }}>Far Maps</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>{maxEachLabel}</div>
          {stats?.cache?.users ? (
            <div style={{ marginLeft: "auto", fontSize: 11, opacity: 0.7 }}>
              cache L1 {stats.cache.users.cacheHitsL1 ?? 0} • redis {stats.cache.users.cacheHitsRedis ?? 0} • fetched{" "}
              {stats.cache.users.fetchedCount ?? 0}
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <ToggleButton active={mode === "following"} onClick={() => setMode("following")}>
            Following
          </ToggleButton>
          <ToggleButton active={mode === "followers"} onClick={() => setMode("followers")}>
            Followers
          </ToggleButton>
          <ToggleButton active={mode === "both"} onClick={() => setMode("both")}>
            Both
          </ToggleButton>

          {/* SHARE BUTTON */}
          <ToggleButton
            active={false}
            onClick={() => {
              if (!fid) return;

              const qs =
                `fid=${fid}` +
                `&mode=${mode}` +
                `&minScore=${minScore}` +
                `&limitEach=800` +
                `&maxEach=${maxEach}` +
                `&concurrency=${concurrency}` +
                `&hubPageSize=${hubPageSize}` +
                `&hubDelayMs=${hubDelayMs}`;

              window.location.href = `/share/map?${qs}`;
            }}
          >
            Share
          </ToggleButton>

          {/* Progressive controls */}
          {canLoadMore ? (
            <ToggleButton
              active={false}
              onClick={() => {
                if (loading) return;
                setAutoLoad(false);
                setMaxEach(nextStep(maxEach));
              }}
            >
              Load more
            </ToggleButton>
          ) : null}

          {/* Auto-load (ramps 5k → 10k → 20k → 50k with delays) */}
          {canLoadMore ? (
            <ToggleButton
              active={autoLoad}
              onClick={() => {
                if (loading) return;
                setAutoLoad((v) => !v);
              }}
            >
              {autoLoad ? "Auto-loading…" : "Auto-load to 50k"}
            </ToggleButton>
          ) : null}
        </div>

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9 }}>
          {fid ? `FID: ${fid}` : "Open inside Warpcast"}
          {stats ? (
            <>
              {" • "}
              followers {stats.followersCount.toLocaleString()} • following {stats.followingCount.toLocaleString()} • pins{" "}
              {stats.count.toLocaleString()}
            </>
          ) : null}
        </div>

        {error && <div style={{ marginTop: 6, fontSize: 12, color: "#ffb4b4" }}>{error}</div>}
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

      {/* Debug */}
      {DEBUG ? (
        <pre
          style={{
            position: "absolute",
            zIndex: 9999,
            bottom: 10,
            left: 10,
            maxWidth: 520,
            maxHeight: 240,
            overflow: "auto",
            background: "rgba(0,0,0,0.7)",
            color: "white",
            padding: 10,
            borderRadius: 12,
            fontSize: 11,
          }}
        >
          {ctxStatus}
          {"\n"}
          {ctxJson}
        </pre>
      ) : null}
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

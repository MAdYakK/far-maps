"use client";

import { useEffect, useMemo, useState } from "react";
import { sdk } from "@farcaster/miniapp-sdk";

type Mode = "followers" | "following" | "both";

function getOrigin() {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

export default function ShareMapPage() {
  const [ready, setReady] = useState(false);
  const [imgUrl, setImgUrl] = useState<string>("");
  const [absImgUrl, setAbsImgUrl] = useState<string>(""); // for embed sharing
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const params = useMemo(() => {
    const sp = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    const fid = sp.get("fid") || "";
    const mode = (sp.get("mode") || "both") as Mode;
    const minScore = sp.get("minScore") || "0.8";
    const limitEach = sp.get("limitEach") || "800";
    const maxEach = sp.get("maxEach") || "5000";
    const concurrency = sp.get("concurrency") || "4";
    const hubPageSize = sp.get("hubPageSize") || "50";
    const hubDelayMs = sp.get("hubDelayMs") || "150";

    return {
      fid,
      mode,
      minScore,
      limitEach,
      maxEach,
      concurrency,
      hubPageSize,
      hubDelayMs,
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await sdk.actions.ready();
      } catch {
        // ignore outside Warpcast
      } finally {
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;

    try {
      setError(null);

      if (!params.fid) {
        setError("Missing fid in URL. Open from the main page.");
        return;
      }

      // ✅ Server-generated image of JUST the map area (no UI)
      // If you want it tighter/less padding, adjust w/h or your /api/map-image renderer.
      const qs =
        `fid=${encodeURIComponent(params.fid)}` +
        `&mode=${encodeURIComponent(params.mode)}` +
        `&minScore=${encodeURIComponent(params.minScore)}` +
        `&limitEach=${encodeURIComponent(params.limitEach)}` +
        `&maxEach=${encodeURIComponent(params.maxEach)}` +
        `&concurrency=${encodeURIComponent(params.concurrency)}` +
        `&hubPageSize=${encodeURIComponent(params.hubPageSize)}` +
        `&hubDelayMs=${encodeURIComponent(params.hubDelayMs)}` +
        `&w=1000&h=1000`;

      const rel = `/api/map-image?${qs}`;
      const abs = `${getOrigin()}${rel}`;

      setImgUrl(rel);
      setAbsImgUrl(abs);
    } catch (e: any) {
      setError(e?.message || "Failed to build image URL");
    }
  }, [ready, params]);

  async function goHome() {
    try {
      const url = `${getOrigin()}/`;
      await sdk.actions.openUrl(url);
    } catch {
      window.location.href = "/";
    }
  }

  async function shareImage() {
    if (!absImgUrl) return;
    try {
      setSharing(true);
      setError(null);

      await sdk.actions.composeCast({
        text: "My Farmap! Check out yours!",
        embeds: [absImgUrl],
      });
    } catch (e: any) {
      setError(e?.message || "Share failed (are you inside Warpcast?)");
    } finally {
      setSharing(false);
    }
  }

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        margin: 0,
        padding: 0,
        overflow: "hidden",
        background: "#cbb7ff", // light purple
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top pill bar */}
      <div
        style={{
          padding: 12,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <PillButton onClick={goHome}>Home</PillButton>

        <PillButton
          onClick={() => {
            if (!sharing) shareImage();
          }}
        >
          {sharing ? "Sharing…" : "Share"}
        </PillButton>

        <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.75, color: "#1b0736" }}>
          {params.mode} • score&gt;{params.minScore}
        </div>
      </div>

      {/* Centered frame */}
      <div
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          padding: 16,
        }}
      >
        <div
          style={{
            width: "min(92vw, 900px)",
            height: "min(78vh, 900px)",
            background: "rgba(27, 7, 54, 0.12)",
            border: "1px solid rgba(27, 7, 54, 0.22)",
            borderRadius: 18,
            padding: 14,
            boxShadow: "0 12px 40px rgba(27, 7, 54, 0.20)",
            display: "grid",
            placeItems: "center",
          }}
        >
          {!imgUrl ? (
            <LoadingCard />
          ) : (
            <div
              style={{
                width: "100%",
                height: "100%",
                borderRadius: 14,
                overflow: "hidden",
                background: "#0b0614", // dark behind map tiles
                display: "grid",
                placeItems: "center",
              }}
            >
              {/* ✅ Constrained to JUST the map image */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imgUrl}
                alt="Far Map"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            </div>
          )}
        </div>

        {error && (
          <div
            style={{
              marginTop: 10,
              width: "min(92vw, 900px)",
              padding: 10,
              borderRadius: 12,
              background: "rgba(0,0,0,0.35)",
              color: "white",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}
      </div>

      <style jsx global>{`
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}

function PillButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: "1px solid rgba(27,7,54,0.25)",
        background: "rgba(255,255,255,0.35)",
        color: "#1b0736",
        padding: "8px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {children}
    </button>
  );
}

function LoadingCard() {
  return (
    <div style={{ display: "grid", placeItems: "center", gap: 10, color: "white" }}>
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
      <div style={{ fontSize: 12, opacity: 0.9 }}>Generating map image…</div>
    </div>
  );
}

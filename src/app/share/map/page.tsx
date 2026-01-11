"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { sdk } from "@farcaster/miniapp-sdk";

type Mode = "followers" | "following" | "both";

function getBaseUrl() {
  // Prefer env on Vercel, fallback to window origin
  const env = process.env.NEXT_PUBLIC_URL;
  if (env && env.startsWith("http")) return env.replace(/\/+$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

export default function ShareMapPage() {
  const router = useRouter();

  const [fid, setFid] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("both");

  const [minScore, setMinScore] = useState("0.8");
  const [limitEach, setLimitEach] = useState("800");
  const [maxEach, setMaxEach] = useState("5000");
  const [concurrency, setConcurrency] = useState("4");
  const [hubPageSize, setHubPageSize] = useState("50");
  const [hubDelayMs, setHubDelayMs] = useState("150");

  const [imgOk, setImgOk] = useState<boolean | null>(null);
  const [imgErr, setImgErr] = useState<string>("");

  const [sharing, setSharing] = useState(false);

  // Pull params from query string; if missing fid, try sdk.context
  useEffect(() => {
    (async () => {
      const sp = new URLSearchParams(window.location.search);

      const qFid = sp.get("fid");
      const qMode = (sp.get("mode") as Mode | null) ?? null;

      if (qMode === "followers" || qMode === "following" || qMode === "both") setMode(qMode);

      if (sp.get("minScore")) setMinScore(sp.get("minScore")!);
      if (sp.get("limitEach")) setLimitEach(sp.get("limitEach")!);
      if (sp.get("maxEach")) setMaxEach(sp.get("maxEach")!);
      if (sp.get("concurrency")) setConcurrency(sp.get("concurrency")!);
      if (sp.get("hubPageSize")) setHubPageSize(sp.get("hubPageSize")!);
      if (sp.get("hubDelayMs")) setHubDelayMs(sp.get("hubDelayMs")!);

      if (qFid && Number.isFinite(Number(qFid))) {
        setFid(Number(qFid));
        return;
      }

      // fallback: try context
      try {
        await sdk.actions.ready();
        const ctx = await sdk.context;
        const detectedFid =
          ((ctx as any)?.viewer?.fid as number | undefined) ??
          ((ctx as any)?.user?.fid as number | undefined);
        if (detectedFid) setFid(detectedFid);
      } catch {
        // ignore
      }
    })();
  }, []);

  // ✅ Relative URL for rendering inside the app (avoids origin weirdness)
  const imageSrc = useMemo(() => {
    if (!fid) return "";
    return (
      `/api/map-image` +
      `?fid=${encodeURIComponent(String(fid))}` +
      `&mode=${encodeURIComponent(mode)}` +
      `&minScore=${encodeURIComponent(minScore)}` +
      `&limitEach=${encodeURIComponent(limitEach)}` +
      `&maxEach=${encodeURIComponent(maxEach)}` +
      `&concurrency=${encodeURIComponent(concurrency)}` +
      `&hubPageSize=${encodeURIComponent(hubPageSize)}` +
      `&hubDelayMs=${encodeURIComponent(hubDelayMs)}` +
      `&w=1000&h=1000` +
      `&v=${Date.now()}` // bust cache for testing
    );
  }, [fid, mode, minScore, limitEach, maxEach, concurrency, hubPageSize, hubDelayMs]);

  // ✅ Absolute URL for embedding in cast
  const imageAbsolute = useMemo(() => {
    if (!fid) return "";
    const base = getBaseUrl();
    if (!base) return "";
    return `${base}${imageSrc.startsWith("/") ? "" : "/"}${imageSrc}`;
  }, [fid, imageSrc]);

  async function shareCast() {
    if (!fid || !imageAbsolute) return;

    try {
      setSharing(true);
      await sdk.actions.composeCast({
        text: "My Farmap! Check out yours!",
        embeds: [imageAbsolute],
      });
    } catch (e: any) {
      setImgErr(e?.message || "Failed to share");
    } finally {
      setSharing(false);
    }
  }

  return (
    <main
      style={{
        height: "100vh",
        width: "100vw",
        margin: 0,
        padding: 0,
        overflow: "hidden",
        background: "#cdb7ff", // light purple
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bubble bar */}
      <div
        style={{
          position: "relative",
          zIndex: 10,
          padding: 12,
        }}
      >
        <div
          style={{
            borderRadius: 14,
            background: "rgba(0,0,0,0.55)",
            color: "white",
            padding: 10,
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <BubbleButton onClick={() => router.push("/")}>Home</BubbleButton>
          <BubbleButton onClick={shareCast} disabled={!fid || !imageAbsolute || sharing}>
            {sharing ? "Sharing…" : "Share Cast"}
          </BubbleButton>

          <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.9 }}>
            {fid ? `FID ${fid} • ${mode}` : "Loading…"}
          </div>
        </div>
      </div>

      {/* Image frame */}
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
            width: "min(92vw, 560px)",
            aspectRatio: "1 / 1",
            borderRadius: 18,
            background: "rgba(255,255,255,0.35)",
            boxShadow: "0 14px 50px rgba(0,0,0,0.25)",
            padding: 12,
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: 14,
              background: "rgba(0,0,0,0.15)",
              overflow: "hidden",
              position: "relative",
              display: "grid",
              placeItems: "center",
            }}
          >
            {!fid ? (
              <div style={{ color: "rgba(0,0,0,0.75)", fontWeight: 700 }}>Loading…</div>
            ) : (
              <>
                {/* If image fails, we show a helpful message */}
                <img
                  src={imageSrc}
                  alt="Farmap"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  onLoad={() => {
                    setImgOk(true);
                    setImgErr("");
                  }}
                  onError={() => {
                    setImgOk(false);
                    setImgErr("Map image failed to load (api/map-image returned an error).");
                  }}
                />

                {imgOk === false ? (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "grid",
                      placeItems: "center",
                      padding: 14,
                      textAlign: "center",
                      background: "rgba(255,255,255,0.85)",
                      color: "#2b1b55",
                      fontWeight: 700,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 14 }}>{imgErr}</div>
                      <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, opacity: 0.9 }}>
                        Try again in a moment (Pinata hub / Neynar can rate-limit).
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function BubbleButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!disabled}
      style={{
        border: "1px solid rgba(255,255,255,0.22)",
        background: disabled ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.18)",
        color: "white",
        padding: "7px 12px",
        borderRadius: 999,
        fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        userSelect: "none",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

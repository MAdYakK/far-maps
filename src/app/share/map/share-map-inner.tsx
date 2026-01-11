"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useState } from "react";
import L from "leaflet";
import { MapContainer, TileLayer, CircleMarker, useMap } from "react-leaflet";
import { fixLeafletIcons } from "@/lib/leafletFix";
import { sdk } from "@farcaster/miniapp-sdk";

export type SharePinPoint = {
  lat: number;
  lng: number;
  city: string;
  count: number;
  users: any[];
};

function FitBounds({ points, ready }: { points: SharePinPoint[]; ready: boolean }) {
  const map = useMap();

  useEffect(() => {
    if (!ready) return;

    if (!points.length) {
      map.setView([20, 0], 2);
      return;
    }

    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [30, 30] });
  }, [points, ready, map]);

  return null;
}

export default function ShareMapInner({
  points,
  ready,
  imageUrl,
  homeUrl,
}: {
  points: SharePinPoint[];
  ready: boolean;
  imageUrl: string;
  homeUrl: string;
}) {
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    fixLeafletIcons();
  }, []);

  const pinRadius = useMemo(() => {
    // slightly smaller pins for share view
    return (count: number) => {
      if (count >= 10) return 5;
      if (count >= 2) return 4;
      return 3;
    };
  }, []);

  async function onShareCast() {
    if (!imageUrl) {
      setShareError("Missing image URL.");
      return;
    }

    try {
      setShareError(null);
      setSharing(true);

      await sdk.actions.composeCast({
        text: "My Farmap! Check out yours!",
        embeds: [imageUrl], // ✅ THIS is the generated PNG
      });
    } catch (e: any) {
      setShareError(e?.message || "Failed to share cast.");
    } finally {
      setSharing(false);
    }
  }

  async function onHome() {
    try {
      // Prefer miniapp navigation if available
      await sdk.actions.openUrl({ url: homeUrl });
    } catch {
      // fallback
      window.location.href = "/";
    }
  }

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#c7b3ff", // light purple backdrop
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bubble controls */}
      <div
        style={{
          padding: 12,
          display: "flex",
          gap: 10,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={onHome}
          style={{
            border: "1px solid rgba(0,0,0,0.18)",
            background: "rgba(255,255,255,0.55)",
            color: "#1b0736",
            padding: "8px 12px",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Home
        </button>

        <button
          type="button"
          onClick={() => {
            if (!sharing) onShareCast();
          }}
          style={{
            border: "1px solid rgba(0,0,0,0.18)",
            background: "rgba(27,7,54,0.85)",
            color: "white",
            padding: "8px 12px",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            opacity: sharing ? 0.7 : 1,
          }}
        >
          {sharing ? "Sharing…" : "Share cast"}
        </button>

        <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.9, color: "#1b0736" }}>
          {ready ? `Pins: ${points.length}` : "Loading…"}
        </div>
      </div>

      {/* Framed image preview + map renderer */}
      <div
        style={{
          flex: 1,
          padding: 14,
          display: "grid",
          placeItems: "center",
        }}
      >
        <div
          style={{
            width: "min(92vw, 720px)",
            aspectRatio: "1 / 1",
            borderRadius: 22,
            overflow: "hidden",
            background: "rgba(255,255,255,0.55)",
            boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
            border: "1px solid rgba(0,0,0,0.12)",
            position: "relative",
          }}
        >
          {/* Render Leaflet map here (this is what your /api/map-image screenshots) */}
          <MapContainer
            center={[20, 0]}
            zoom={2}
            style={{ height: "100%", width: "100%" }}
            zoomControl={false}
            attributionControl={false}
          >
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <FitBounds points={points} ready={ready} />

            {points.map((p) => (
              <CircleMarker
                key={`${p.lat},${p.lng}`}
                center={[p.lat, p.lng]}
                radius={pinRadius(p.count)}
                pathOptions={{ weight: 0 }}
              />
            ))}
          </MapContainer>

          {/* Optional: show that the image URL exists (doesn't open it) */}
          {!imageUrl ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                color: "#1b0736",
                fontWeight: 700,
                background: "rgba(255,255,255,0.4)",
              }}
            >
              Missing imageUrl
            </div>
          ) : null}
        </div>
      </div>

      {shareError ? (
        <div style={{ padding: 12, fontSize: 12, color: "#7a1230", fontWeight: 700 }}>
          {shareError}
        </div>
      ) : null}
    </div>
  );
}

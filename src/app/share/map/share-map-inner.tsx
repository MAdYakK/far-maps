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

declare global {
  interface Window {
    __FARMAPS_MAP_READY__?: boolean;
  }
}

function FitBoundsAndSignalReady({
  points,
  ready,
}: {
  points: SharePinPoint[];
  ready: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    window.__FARMAPS_MAP_READY__ = false;

    if (!ready) return;

    if (!points.length) {
      map.setView([20, 0], 2);
      // give the map a beat then mark ready
      requestAnimationFrame(() => {
        window.__FARMAPS_MAP_READY__ = true;
      });
      return;
    }

    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));

    // Keep this padding in ONE place (this ensures share view == image view)
    map.fitBounds(bounds, { padding: [30, 30] });

    const onDone = () => {
      // Let tiles/pins render for a frame or two for stable screenshots.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.__FARMAPS_MAP_READY__ = true;
        });
      });
      map.off("moveend", onDone);
    };

    map.on("moveend", onDone);
    return () => {
      map.off("moveend", onDone);
    };
  }, [points, ready, map]);

  return null;
}

function pinStyle(count: number) {
  // Bright “stands out on OSM” palette
  // Smaller = cooler, bigger = warmer
  if (count >= 25) return { color: "#ff2d55", fill: "#ff2d55", r: 7 }; // hot pink
  if (count >= 10) return { color: "#ff9500", fill: "#ff9500", r: 6 }; // orange
  if (count >= 5) return { color: "#ffd60a", fill: "#ffd60a", r: 5 }; // yellow
  if (count >= 2) return { color: "#32d74b", fill: "#32d74b", r: 4 }; // neon green
  return { color: "#0a84ff", fill: "#0a84ff", r: 3 }; // bright blue
}

export default function ShareMapInner({
  points,
  ready,
  imageUrl,
  homeUrl,
  renderOnly,
}: {
  points: SharePinPoint[];
  ready: boolean;
  imageUrl: string;
  homeUrl: string;
  renderOnly: boolean;
}) {
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    fixLeafletIcons();
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
        embeds: [imageUrl], // ✅ share the generated PNG endpoint
      });
    } catch (e: any) {
      setShareError(e?.message || "Failed to share cast.");
    } finally {
      setSharing(false);
    }
  }

  async function onHome() {
    try {
      await sdk.actions.openUrl({ url: homeUrl });
    } catch {
      window.location.href = "/";
    }
  }

  const pinCount = points.length;

  // Frame sizing: renderOnly should be a clean capture area
  const frame = useMemo(() => {
    if (renderOnly) {
      return {
        max: "1000px",
        aspect: "1 / 1",
        pad: 24,
      };
    }
    return {
      max: "720px",
      aspect: "1 / 1",
      pad: 14,
    };
  }, [renderOnly]);

  // Content wrapper
  if (renderOnly) {
    // ✅ Screenshot mode (no buttons)
    return (
      <div
        id="farmaps-capture-root"
        style={{
          width: "100vw",
          height: "100vh",
          background: "#c7b3ff",
          display: "grid",
          placeItems: "center",
          padding: frame.pad,
        }}
      >
        <div
          id="farmaps-capture-frame"
          style={{
            width: `min(100vw - ${frame.pad * 2}px, ${frame.max})`,
            aspectRatio: frame.aspect,
            borderRadius: 28,
            overflow: "hidden",
            background: "rgba(255,255,255,0.55)",
            border: "1px solid rgba(0,0,0,0.12)",
            boxShadow: "0 22px 70px rgba(0,0,0,0.25)",
            position: "relative",
          }}
        >
          <MapContainer
            center={[20, 0]}
            zoom={2}
            style={{ height: "100%", width: "100%" }}
            zoomControl={false}
            attributionControl={false}
            dragging={false}
            doubleClickZoom={false}
            scrollWheelZoom={false}
            boxZoom={false}
            keyboard={false}
          >
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <FitBoundsAndSignalReady points={points} ready={ready} />

            {points.map((p) => {
              const s = pinStyle(p.count);
              return (
                <CircleMarker
                  key={`${p.lat},${p.lng}`}
                  center={[p.lat, p.lng]}
                  radius={s.r}
                  pathOptions={{
                    color: s.color,
                    fillColor: s.fill,
                    fillOpacity: 0.85,
                    weight: 1,
                    opacity: 0.95,
                  }}
                />
              );
            })}
          </MapContainer>

          {/* Watermark */}
          <div
            style={{
              position: "absolute",
              right: 14,
              bottom: 12,
              padding: "6px 10px",
              borderRadius: 999,
              background: "rgba(0,0,0,0.35)",
              color: "white",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 0.2,
              userSelect: "none",
            }}
          >
            Far Maps
          </div>

          {/* Tiny legend */}
          <div
            style={{
              position: "absolute",
              left: 14,
              bottom: 12,
              padding: "6px 10px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.55)",
              color: "#1b0736",
              fontSize: 11,
              fontWeight: 700,
              userSelect: "none",
            }}
          >
            Pins: {pinCount}
          </div>
        </div>
      </div>
    );
  }

  // ✅ Normal share page UI
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#c7b3ff",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bubble controls */}
      <div style={{ padding: 12, display: "flex", gap: 10, alignItems: "center" }}>
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
          {ready ? `Pins: ${pinCount}` : "Loading…"}
        </div>
      </div>

      {/* Framed map */}
      <div style={{ flex: 1, padding: frame.pad, display: "grid", placeItems: "center" }}>
        <div
          style={{
            width: `min(92vw, ${frame.max})`,
            aspectRatio: frame.aspect,
            borderRadius: 22,
            overflow: "hidden",
            background: "rgba(255,255,255,0.55)",
            boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
            border: "1px solid rgba(0,0,0,0.12)",
            position: "relative",
          }}
        >
          <MapContainer
            center={[20, 0]}
            zoom={2}
            style={{ height: "100%", width: "100%" }}
            zoomControl={false}
            attributionControl={false}
          >
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <FitBoundsAndSignalReady points={points} ready={ready} />

            {points.map((p) => {
              const s = pinStyle(p.count);
              return (
                <CircleMarker
                  key={`${p.lat},${p.lng}`}
                  center={[p.lat, p.lng]}
                  radius={s.r}
                  pathOptions={{
                    color: s.color,
                    fillColor: s.fill,
                    fillOpacity: 0.85,
                    weight: 1,
                    opacity: 0.95,
                  }}
                />
              );
            })}
          </MapContainer>

          <div
            style={{
              position: "absolute",
              right: 12,
              bottom: 10,
              padding: "6px 10px",
              borderRadius: 999,
              background: "rgba(0,0,0,0.35)",
              color: "white",
              fontSize: 12,
              fontWeight: 700,
              userSelect: "none",
            }}
          >
            Far Maps
          </div>
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

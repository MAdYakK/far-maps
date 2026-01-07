"use client";

import { useEffect, useMemo, useState } from "react";
import type { LatLngExpression } from "leaflet";
import { sdk } from "@farcaster/miniapp-sdk";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { fixLeafletIcons } from "@/lib/leafletFix";

type Point = {
  fid: number;
  username: string;
  display_name?: string;
  pfp_url?: string;
  city: string;
  lat: number;
  lng: number;
};

export default function HomePage() {
  const [fid, setFid] = useState<number | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fixLeafletIcons();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const ctx = await sdk.context;
        // SDK typing lag — cast safely
        const viewerFid = (ctx as any)?.viewer?.fid as number | undefined;

        if (viewerFid) setFid(viewerFid);
      } catch {
        // If opened in a normal browser, fid will remain null
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
          maxWidth: 320,
        }}
      >
        <div style={{ fontWeight: 700 }}>
          {process.env.NEXT_PUBLIC_APP_NAME || "Far Maps"}
        </div>
        <div style={{ fontSize: 12, opacity: 0.9 }}>
          Followers + Following by city
        </div>
        <div style={{ marginTop: 8, fontSize: 12 }}>
          {fid ? (
            <>Viewer FID: {fid}</>
          ) : (
            <>Open inside Warpcast to load your network.</>
          )}
        </div>
        <div style={{ marginTop: 6, fontSize: 12 }}>
          {loading ? "Loading…" : `Pins: ${points.length}`}
        </div>
        {error && (
          <div style={{ marginTop: 6, fontSize: 12, color: "#ffb4b4" }}>
            {error}
          </div>
        )}
      </div>

      <MapContainer
        center={center}
        zoom={points.length ? 3 : 4}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="© OpenStreetMap"
        />

        {points.map((p) => (
          <Marker key={p.fid} position={[p.lat, p.lng]}>
            <Popup>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {p.pfp_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.pfp_url}
                    alt=""
                    width={28}
                    height={28}
                    style={{ borderRadius: 999 }}
                  />
                ) : null}
                <div>
                  <div style={{ fontWeight: 700 }}>@{p.username}</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>{p.city}</div>
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </main>
  );
}

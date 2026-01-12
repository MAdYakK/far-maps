"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo } from "react";
import L from "leaflet";
import { MapContainer, TileLayer, CircleMarker, useMap } from "react-leaflet";
import { fixLeafletIcons } from "@/lib/leafletFix";

export type SharePinPoint = {
  lat: number;
  lng: number;
  city: string;
  count: number;
  users: any[];
};

const WORLD_BOUNDS = L.latLngBounds(
  L.latLng(-85, -180),
  L.latLng(85, 180)
);

function getMarkerStyle(count: number) {
  // Smaller overall than before
  if (count >= 8) return { r: 6, fill: "#7C3AED" }; // purple
  if (count >= 4) return { r: 5, fill: "#06B6D4" }; // cyan
  if (count >= 2) return { r: 4, fill: "#F59E0B" }; // amber
  return { r: 3, fill: "#84CC16" }; // lime
}

function FitBounds({ points, ready }: { points: SharePinPoint[]; ready: boolean }) {
  const map = useMap();

  useEffect(() => {
    if (!ready) return;

    // lock to one world
    map.setMaxBounds(WORLD_BOUNDS);

    if (!points.length) {
      map.setView([20, 0], 2);
      return;
    }

    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 4);
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
}: {
  points: SharePinPoint[];
  ready: boolean;
}) {
  useEffect(() => {
    fixLeafletIcons();
  }, []);

  // draw small first, big last (big on top)
  const ordered = useMemo(() => {
    return [...points].sort((a, b) => a.count - b.count);
  }, [points]);

  return (
    <MapContainer
      center={[20, 0]}
      zoom={2}
      style={{ height: "100%", width: "100%" }}
      zoomControl={false}
      attributionControl={false}
      worldCopyJump={false}
      maxBounds={WORLD_BOUNDS}
      maxBoundsViscosity={1.0}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        noWrap
        bounds={WORLD_BOUNDS}
      />

      <FitBounds points={ordered} ready={ready} />

      {ordered.map((p) => {
        const s = getMarkerStyle(p.count);
        return (
          <CircleMarker
            key={`${p.lat},${p.lng}`}
            center={[p.lat, p.lng]}
            radius={s.r}
            pathOptions={{
              color: "rgba(0,0,0,0.55)",
              weight: 1.25,
              fillColor: s.fill,
              fillOpacity: 0.95,
            }}
          />
        );
      })}
    </MapContainer>
  );
}

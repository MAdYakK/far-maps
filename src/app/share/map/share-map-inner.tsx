"use client";

import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  useMap,
} from "react-leaflet";
import { fixLeafletIcons } from "@/lib/leafletFix";

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

    const bounds = L.latLngBounds(
      points.map((p) => [p.lat, p.lng] as [number, number])
    );

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

  return (
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
          radius={p.count > 1 ? 6 : 4}
        />
      ))}
    </MapContainer>
  );
}

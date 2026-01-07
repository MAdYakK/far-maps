"use client";

import { useEffect } from "react";
import type { LatLngExpression } from "leaflet";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { fixLeafletIcons } from "@/lib/leafletFix";

export type Point = {
  fid: number;
  username: string;
  display_name?: string;
  pfp_url?: string;
  city: string;
  lat: number;
  lng: number;
};

export default function LeafletMap({
  center,
  zoom,
  points,
}: {
  center: LatLngExpression;
  zoom: number;
  points: Point[];
}) {
  useEffect(() => {
    fixLeafletIcons();
  }, []);

  return (
    <MapContainer center={center} zoom={zoom} style={{ height: "100%", width: "100%" }}>
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
  );
}

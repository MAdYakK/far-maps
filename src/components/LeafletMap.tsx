"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useState } from "react";
import type { LatLngExpression } from "leaflet";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { fixLeafletIcons } from "@/lib/leafletFix";

export type PinUser = {
  fid: number;
  username: string;
  display_name?: string;
  pfp_url?: string;
  score: number;
};

export type PinPoint = {
  lat: number;
  lng: number;
  city: string;
  count: number;
  users: PinUser[];
};

export default function LeafletMap({
  center,
  zoom,
  points,
}: {
  center: LatLngExpression;
  zoom: number;
  points: PinPoint[];
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
        <Marker key={`${p.lat},${p.lng}`} position={[p.lat, p.lng]}>
          <Popup>
            <div style={{ minWidth: 220, maxWidth: 280 }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>
                {p.city}
              </div>
              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                {p.count} {p.count === 1 ? "person" : "people"} here
              </div>

              <UserList users={p.users} />
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}

function UserList({ users }: { users: PinUser[] }) {
  const [expanded, setExpanded] = useState(false);

  const sorted = useMemo(() => {
    const arr = [...users];
    arr.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.username.localeCompare(b.username);
    });
    return arr;
  }, [users]);

  const shown = expanded ? sorted : sorted.slice(0, 8);

  return (
    <div>
      <div style={{ display: "grid", gap: 8 }}>
        {shown.map((u) => (
          <div key={u.fid} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {u.pfp_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={u.pfp_url}
                alt=""
                width={26}
                height={26}
                style={{ borderRadius: 999, flex: "0 0 auto" }}
              />
            ) : (
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 999,
                  background: "rgba(0,0,0,0.12)",
                  flex: "0 0 auto",
                }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.1 }}>
                @{u.username}
              </div>
              <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.1 }}>
                {u.display_name || ""}{" "}
                <span style={{ opacity: 0.65 }}>• score {u.score.toFixed(2)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {sorted.length > 8 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginTop: 10,
            width: "100%",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: "rgba(0,0,0,0.04)",
            padding: "6px 10px",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          {expanded ? "Show fewer" : `Show all (${sorted.length})`}
        </button>
      )}
    </div>
  );
}

"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useState } from "react";
import type { LatLngExpression } from "leaflet";
import L from "leaflet";
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

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ──────────────────────────────────────────────────────────────
   Icon caches (persist per warm instance)
   ────────────────────────────────────────────────────────────── */

const g = globalThis as any;

if (!g.__FARMAPS_PFP_ICON_CACHE__) g.__FARMAPS_PFP_ICON_CACHE__ = new Map<string, L.DivIcon>();
if (!g.__FARMAPS_COUNT_ICON_CACHE__) g.__FARMAPS_COUNT_ICON_CACHE__ = new Map<number, L.DivIcon>();

const pfpIconCache: Map<string, L.DivIcon> = g.__FARMAPS_PFP_ICON_CACHE__;
const countIconCache: Map<number, L.DivIcon> = g.__FARMAPS_COUNT_ICON_CACHE__;

const MAX_PFP_ICONS = 5000;   // cap unique pfps cached
const MAX_COUNT_ICONS = 300;  // cap unique counts cached

function pruneMap<K, V>(m: Map<K, V>, max: number) {
  if (m.size <= max) return;
  // delete oldest inserted keys (Map keeps insertion order)
  const overflow = m.size - max;
  let removed = 0;
  for (const key of m.keys()) {
    m.delete(key);
    removed++;
    if (removed >= overflow) break;
  }
}

function makeCountIcon(count: number) {
  const size = count >= 100 ? 44 : count >= 10 ? 40 : 36;
  const fontSize = count >= 100 ? 14 : 15;

  const html = `
    <div style="
      width:${size}px;
      height:${size}px;
      border-radius:9999px;
      display:grid;
      place-items:center;
      background: rgba(255,255,255,0.15);
      border: 2px solid rgba(255,255,255,0.65);
      box-shadow: 0 6px 18px rgba(0,0,0,0.35);
      backdrop-filter: blur(6px);
      color: white;
      font-weight: 800;
      font-size:${fontSize}px;
      line-height:1;
      text-shadow: 0 2px 6px rgba(0,0,0,0.45);
      user-select:none;
    ">
      ${count}
    </div>
  `;

  return L.divIcon({
    className: "",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function getCountIconCached(count: number) {
  const c = Math.max(1, Math.floor(count));
  const existing = countIconCache.get(c);
  if (existing) return existing;

  const created = makeCountIcon(c);
  countIconCache.set(c, created);
  pruneMap(countIconCache, MAX_COUNT_ICONS);
  return created;
}

function makePfpIcon(pfpUrl: string) {
  const size = 40;
  const safeUrl = escapeHtml(pfpUrl);

  const html = `
    <div style="
      width:${size}px;
      height:${size}px;
      border-radius:9999px;
      overflow:hidden;
      border: 2px solid rgba(255,255,255,0.75);
      box-shadow: 0 6px 18px rgba(0,0,0,0.35);
      background: rgba(255,255,255,0.12);
    ">
      <img
        src="${safeUrl}"
        style="
          width:100%;
          height:100%;
          object-fit:cover;
          display:block;
        "
        referrerpolicy="no-referrer"
        onerror="this.style.display='none';"
      />
    </div>
  `;

  return L.divIcon({
    className: "",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function getPfpIconCached(pfpUrl: string) {
  // normalize key a tiny bit (avoid caching empty/whitespace variants)
  const key = pfpUrl.trim();
  const existing = pfpIconCache.get(key);
  if (existing) return existing;

  const created = makePfpIcon(key);
  pfpIconCache.set(key, created);
  pruneMap(pfpIconCache, MAX_PFP_ICONS);
  return created;
}

function pickPinIcon(p: PinPoint) {
  if (p.count > 1) return getCountIconCached(p.count);

  const u = p.users?.[0];
  if (u?.pfp_url) return getPfpIconCached(u.pfp_url);

  return getCountIconCached(1);
}

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

  const markerData = useMemo(() => {
    return points.map((p) => ({
      key: `${p.lat},${p.lng}`,
      p,
      icon: pickPinIcon(p),
    }));
  }, [points]);

  return (
    <MapContainer center={center} zoom={zoom} style={{ height: "100%", width: "100%" }}>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="© OpenStreetMap"
      />

      {markerData.map(({ key, p, icon }) => (
        <Marker key={key} position={[p.lat, p.lng]} icon={icon}>
          <Popup>
            <div style={{ minWidth: 220, maxWidth: 280 }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>{p.city}</div>
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
                referrerPolicy="no-referrer"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
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

// src/app/api/map-image/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

type Mode = "followers" | "following" | "both";

type PinUser = {
  fid: number;
  username: string;
  display_name?: string;
  pfp_url?: string;
  score: number;
};

type PinPoint = {
  lat: number;
  lng: number;
  city: string;
  count: number;
  users: PinUser[];
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function numParam(sp: URLSearchParams, key: string, fallback: number) {
  const v = Number(sp.get(key));
  return Number.isFinite(v) ? v : fallback;
}

function strParam(sp: URLSearchParams, key: string, fallback: string) {
  const v = sp.get(key);
  return v && v.length ? v : fallback;
}

function modeParam(sp: URLSearchParams, key: string, fallback: Mode): Mode {
  const v = sp.get(key);
  if (v === "followers" || v === "following" || v === "both") return v;
  return fallback;
}

function getOrigin(req: Request) {
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") || u.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || u.host;
  return `${proto}://${host}`;
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildLeafletHtml(points: PinPoint[], w: number, h: number) {
  const safePoints = points
    .filter(
      (p) =>
        typeof p.lat === "number" &&
        typeof p.lng === "number" &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng)
    )
    .map((p) => ({
      lat: p.lat,
      lng: p.lng,
      count: typeof p.count === "number" ? p.count : 1,
      city: escapeHtml(p.city || "Unknown"),
    }));

  const pointsJson = JSON.stringify(safePoints);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=${w}, height=${h}, initial-scale=1" />
    <link
      rel="stylesheet"
      href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      crossorigin=""
    />
    <style>
      html, body { margin:0; padding:0; width:${w}px; height:${h}px; background:#111; overflow:hidden; }
      #map { width:${w}px; height:${h}px; }
      .leaflet-control-container { display:none; }
    </style>
  </head>
  <body>
    <div id="map"></div>

    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>

    <script>
      const points = ${pointsJson};

      const map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        preferCanvas: true
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18
      }).addTo(map);

      if (!points.length) {
        map.setView([20, 0], 2);
      } else {
        const latlngs = points.map(p => [p.lat, p.lng]);
        const bounds = L.latLngBounds(latlngs);
        map.fitBounds(bounds, { padding: [24, 24] });
      }

      points.forEach(p => {
        const r =
          p.count >= 25 ? 4 :
          p.count >= 10 ? 3.5 :
          p.count >= 5  ? 3 :
          p.count >= 2  ? 2.5 : 2;

        L.circleMarker([p.lat, p.lng], {
          radius: r,
          weight: 0,
          fillOpacity: 0.9
        }).addTo(map);
      });

      window.__MAP_READY__ = true;
    </script>
  </body>
</html>`;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const fid = numParam(searchParams, "fid", NaN);
    if (!Number.isFinite(fid) || fid <= 0) {
      return NextResponse.json({ error: "Missing or invalid fid" }, { status: 400 });
    }

    const mode = modeParam(searchParams, "mode", "both");
    const minScore = strParam(searchParams, "minScore", "0.8");
    const limitEach = strParam(searchParams, "limitEach", "800");
    const maxEach = strParam(searchParams, "maxEach", "5000");
    const concurrency = strParam(searchParams, "concurrency", "4");
    const hubPageSize = strParam(searchParams, "hubPageSize", "50");
    const hubDelayMs = strParam(searchParams, "hubDelayMs", "150");

    const w = Math.max(300, Math.min(2000, numParam(searchParams, "w", 1000)));
    const h = Math.max(300, Math.min(2000, numParam(searchParams, "h", 1000)));

    const origin = getOrigin(req);
    const networkUrl =
      `${origin}/api/network?fid=${encodeURIComponent(String(fid))}` +
      `&mode=${encodeURIComponent(mode)}` +
      `&minScore=${encodeURIComponent(minScore)}` +
      `&limitEach=${encodeURIComponent(limitEach)}` +
      `&maxEach=${encodeURIComponent(maxEach)}` +
      `&concurrency=${encodeURIComponent(concurrency)}` +
      `&hubPageSize=${encodeURIComponent(hubPageSize)}` +
      `&hubDelayMs=${encodeURIComponent(hubDelayMs)}`;

    const netRes = await fetch(networkUrl, { cache: "no-store" });
    const netText = await netRes.text();

    let netJson: any = null;
    try {
      netJson = netText ? JSON.parse(netText) : null;
    } catch {
      netJson = null;
    }

    if (!netRes.ok) {
      const msg =
        netJson?.error ||
        `network error ${netRes.status} ${netRes.statusText}${
          netText ? ` — ${netText.slice(0, 200)}` : ""
        }`;
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const points: PinPoint[] = Array.isArray(netJson?.points) ? netJson.points : [];
    const html = buildLeafletHtml(points, w, h);

    const executablePath = await chromium.executablePath();

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: w, height: h, deviceScaleFactor: 2 },
      executablePath,
      headless: true,
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "domcontentloaded" });

      await page
        .waitForFunction("window.__MAP_READY__ === true", { timeout: 8000 })
        .catch(() => {});

      await sleep(1400);

      const png = await page.screenshot({ type: "png" });

      return new Response(png as Buffer, {
        headers: {
          "content-type": "image/png",
          "cache-control": "no-store",
        },
      });
    } finally {
      await browser.close();
    }
  } catch (e: any) {
    console.error("api/map-image error:", e);
    return NextResponse.json(
      { error: e?.message || "Server error", detail: String(e?.stack || "") },
      { status: 500 }
    );
  }
}

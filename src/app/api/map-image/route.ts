export const runtime = "nodejs";

import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

type Mode = "followers" | "following" | "both";

type NetworkResponse = {
  fid: number;
  mode: Mode;
  points: Array<{
    lat: number;
    lng: number;
    city: string;
    count: number;
    users: Array<{
      fid: number;
      username: string;
      display_name?: string;
      pfp_url?: string;
      score: number;
    }>;
  }>;
};

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function parseNum(sp: URLSearchParams, key: string, d: number) {
  const v = Number(sp.get(key));
  return Number.isFinite(v) ? v : d;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function computeBounds(points: { lat: number; lng: number }[]) {
  if (!points.length) return null;

  let minLat = 90,
    maxLat = -90,
    minLng = 180,
    maxLng = -180;

  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }

  if (minLat > maxLat || minLng > maxLng) return null;

  // If all points are the same coordinate, expand slightly so fitBounds works nicely
  if (minLat === maxLat) {
    minLat -= 0.25;
    maxLat += 0.25;
  }
  if (minLng === maxLng) {
    minLng -= 0.25;
    maxLng += 0.25;
  }

  return {
    sw: [round2(minLat), round2(minLng)],
    ne: [round2(maxLat), round2(maxLng)],
  };
}

function bucketLabel(count: number) {
  if (count >= 8) return "8+ users";
  if (count >= 4) return "4–7 users";
  if (count >= 2) return "2–3 users";
  return "1 user";
}

function bucketKey(count: number) {
  if (count >= 8) return "b8";
  if (count >= 4) return "b4";
  if (count >= 2) return "b2";
  return "b1";
}

function bucketColor(key: string) {
  // High contrast on OSM water/land
  // b1 = lime, b2 = orange, b4 = cyan, b8 = purple
  if (key === "b8") return "#6D28D9";
  if (key === "b4") return "#06B6D4";
  if (key === "b2") return "#F59E0B";
  return "#84CC16";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;

  try {
    const fid = parseNum(sp, "fid", NaN);
    if (!Number.isFinite(fid) || fid <= 0) {
      return NextResponse.json({ error: "Missing or invalid fid" }, { status: 400 });
    }

    const mode = (sp.get("mode") || "both") as Mode;
    if (mode !== "followers" && mode !== "following" && mode !== "both") {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }

    const minScore = sp.get("minScore") || "0.8";
    const limitEach = sp.get("limitEach") || "800";
    const maxEach = sp.get("maxEach") || "5000";
    const concurrency = sp.get("concurrency") || "4";
    const hubPageSize = sp.get("hubPageSize") || "50";
    const hubDelayMs = sp.get("hubDelayMs") || "150";

    const w = clamp(parseNum(sp, "w", 1000), 600, 2000);
    const h = clamp(parseNum(sp, "h", 1000), 600, 2000);

    // Pull username from network payload (we’ll use the first user that matches fid when possible)
    const base =
      process.env.NEXT_PUBLIC_URL && process.env.NEXT_PUBLIC_URL.startsWith("http")
        ? process.env.NEXT_PUBLIC_URL.replace(/\/+$/, "")
        : "";

    // Use an internal fetch to your own /api/network endpoint
    // NOTE: use absolute on server if possible, fallback to relative (Vercel should still work with absolute)
    const networkUrl =
      (base ? `${base}` : "") +
      `/api/network?fid=${encodeURIComponent(String(fid))}` +
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

    if (!netRes.ok || !netJson) {
      return NextResponse.json(
        {
          error: "Failed to fetch network for image",
          detail: netJson?.error || netText?.slice(0, 300) || `status ${netRes.status}`,
        },
        { status: 500 }
      );
    }

    const net = netJson as NetworkResponse;
    const pointsRaw = Array.isArray(net.points) ? net.points : [];

    // Determine username for watermark: try to find the current user in any pin users list
    let username = "";
    for (const p of pointsRaw) {
      const u = (p.users || []).find((x) => x?.fid === fid);
      if (u?.username) {
        username = u.username;
        break;
      }
    }
    if (!username) username = "user";

    // Sort points so higher counts are rendered last (on top)
    const points = [...pointsRaw].sort((a, b) => (a.count || 0) - (b.count || 0));

    // Legend stats
    const legend = {
      b1: 0,
      b2: 0,
      b4: 0,
      b8: 0,
      pins: pointsRaw.length,
      users: pointsRaw.reduce((acc, p) => acc + (p.users?.length || 0), 0),
    };

    for (const p of pointsRaw) {
      const k = bucketKey(p.count || 0) as keyof typeof legend;
      if (k === "b1" || k === "b2" || k === "b4" || k === "b8") legend[k] += 1;
    }

    const bounds = computeBounds(pointsRaw.map((p) => ({ lat: p.lat, lng: p.lng })));

    // Build HTML that renders a FULL-CARD map (no centered square)
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <style>
    :root{
      --purple:#cdb7ff;
      --card: rgba(255,255,255,0.35);
      --ink: rgba(0,0,0,0.75);
    }
    html, body {
      margin:0;
      padding:0;
      width:${w}px;
      height:${h}px;
      background: var(--purple);
      overflow:hidden;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
    }

    /* Outer purple background */
    #frame{
      position:relative;
      width:100%;
      height:100%;
      background: var(--purple);
      padding: 14px;
      box-sizing: border-box;
    }

    /* Full card fills frame */
    #card{
      position:relative;
      width:100%;
      height:100%;
      border-radius: 28px;
      background: var(--card);
      box-shadow: 0 18px 60px rgba(0,0,0,0.22);
      overflow:hidden;
    }

    /* Inner map window fills the whole card (THIS IS THE KEY FIX) */
    #mapWrap{
      position:absolute;
      inset: 14px;          /* small inset so rounded edges show */
      border-radius: 22px;
      overflow:hidden;
      background: rgba(0,0,0,0.10);
    }

    #map{
      width:100%;
      height:100%;
    }

    /* Overlays sit ON TOP of the map */
    .overlay{
      position:absolute;
      z-index:9999;
      display:flex;
      gap:10px;
      pointer-events:none;
    }

    #legend{
      left: 26px;
      bottom: 26px;
      background: rgba(0,0,0,0.62);
      color: white;
      border-radius: 16px;
      padding: 12px 12px 10px 12px;
      width: 300px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.22);
      pointer-events:none;
    }

    #legendTitle{
      display:flex;
      justify-content:space-between;
      align-items:center;
      font-weight:800;
      font-size:14px;
      margin-bottom:8px;
    }

    .row{
      display:flex;
      justify-content:space-between;
      align-items:center;
      font-size:13px;
      padding: 5px 0;
      border-top: 1px solid rgba(255,255,255,0.10);
    }
    .row:first-of-type{ border-top:none; }
    .left{
      display:flex;
      align-items:center;
      gap:10px;
      opacity:0.95;
    }
    .dot{
      width: 12px;
      height: 12px;
      border-radius: 999px;
      box-shadow: 0 0 0 2px rgba(0,0,0,0.35);
    }

    #watermark{
      right: 26px;
      bottom: 26px;
      background: rgba(0,0,0,0.62);
      color: white;
      border-radius: 999px;
      padding: 10px 14px;
      font-weight: 800;
      font-size: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.22);
    }

    /* Make leaflet look cleaner */
    .leaflet-control-container { display:none; }
    .leaflet-tile { filter: saturate(1.05) contrast(1.03); }
  </style>
</head>
<body>
  <div id="frame">
    <div id="card">
      <div id="mapWrap"><div id="map"></div></div>

      <div id="legend" class="overlay">
        <div style="width:100%">
          <div id="legendTitle">
            <div>Legend</div>
            <div style="opacity:0.9;font-weight:700">${legend.pins} pins • ${legend.users} users</div>
          </div>
          <div class="row">
            <div class="left"><span class="dot" style="background:${bucketColor("b1")}"></span>1 user</div>
            <div style="font-weight:800">${legend.b1} pins</div>
          </div>
          <div class="row">
            <div class="left"><span class="dot" style="background:${bucketColor("b2")}"></span>2–3 users</div>
            <div style="font-weight:800">${legend.b2} pins</div>
          </div>
          <div class="row">
            <div class="left"><span class="dot" style="background:${bucketColor("b4")}"></span>4–7 users</div>
            <div style="font-weight:800">${legend.b4} pins</div>
          </div>
          <div class="row">
            <div class="left"><span class="dot" style="background:${bucketColor("b8")}"></span>8+ users</div>
            <div style="font-weight:800">${legend.b8} pins</div>
          </div>
        </div>
      </div>

      <div id="watermark" class="overlay">Far Maps • ${String(username).replace(/</g, "&lt;")}</div>
    </div>
  </div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const points = ${JSON.stringify(
      points.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        count: p.count || 1,
      }))
    )};

    const bounds = ${JSON.stringify(bounds)};

    function bucketKey(count){
      if (count >= 8) return "b8";
      if (count >= 4) return "b4";
      if (count >= 2) return "b2";
      return "b1";
    }

    const colors = {
      b1: "${bucketColor("b1")}",
      b2: "${bucketColor("b2")}",
      b4: "${bucketColor("b4")}",
      b8: "${bucketColor("b8")}",
    };

    // Slightly smaller pins than before
    function radiusFor(count){
      // base small, grows gently
      if (count >= 8) return 7;
      if (count >= 4) return 6;
      if (count >= 2) return 5;
      return 4;
    }

    const map = L.map("map", {
      zoomControl:false,
      attributionControl:false,
      worldCopyJump:true,
      preferCanvas:true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 8,
      minZoom: 1,
    }).addTo(map);

    if (!points.length) {
      map.setView([20,0], 2);
    } else if (bounds && bounds.sw && bounds.ne) {
      const b = L.latLngBounds(bounds.sw, bounds.ne);
      // Padding matches your Share view logic (30)
      map.fitBounds(b, { padding:[30,30] });
    } else {
      map.setView([20,0], 2);
    }

    // Render in ascending count order already, so bigger ones appear later (on top)
    for (const p of points) {
      const k = bucketKey(p.count);
      const color = colors[k] || colors.b1;
      const r = radiusFor(p.count);

      L.circleMarker([p.lat, p.lng], {
        radius: r,
        weight: 2,
        color: "rgba(0,0,0,0.55)",
        fillColor: color,
        fillOpacity: 0.95,
      }).addTo(map);
    }

    // Signal to puppeteer
    window.__MAP_READY__ = true;
  </script>
</body>
</html>`;

    // Puppeteer + Chromium (Vercel)
    const executablePath = await chromium.executablePath();

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: w, height: h },
      executablePath,
      headless: true,
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });

      // wait until leaflet has rendered markers
      await page.waitForFunction("window.__MAP_READY__ === true", { timeout: 15_000 });
      await new Promise((r) => setTimeout(r, 250)); // tiny settle

      const png = await page.screenshot({ type: "png" });

      return new NextResponse(png as any, {
        status: 200,
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
      { error: e?.message || "Server error", detail: String(e?.stack || "")?.slice(0, 2000) },
      { status: 500 }
    );
  }
}

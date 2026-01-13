export const runtime = "nodejs";

import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { createRequire } from "module";

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

const require = createRequire(import.meta.url);

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

const WORLD_MIN_LAT = -85.0511;
const WORLD_MAX_LAT = 85.0511;
const WORLD_MIN_LNG = -180;
const WORLD_MAX_LNG = 180;

function normalizeLng(lng: number) {
  let x = lng;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function computeBounds(points: { lat: number; lng: number }[]) {
  if (!points.length) return null;

  let minLat = 90,
    maxLat = -90,
    minLng = 180,
    maxLng = -180;

  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;

    const lat = clamp(p.lat, WORLD_MIN_LAT, WORLD_MAX_LAT);
    const lng = normalizeLng(p.lng);

    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }

  if (minLat > maxLat || minLng > maxLng) return null;

  // Expand if single coordinate so fitBounds works
  if (minLat === maxLat) {
    minLat = clamp(minLat - 0.25, WORLD_MIN_LAT, WORLD_MAX_LAT);
    maxLat = clamp(maxLat + 0.25, WORLD_MIN_LAT, WORLD_MAX_LAT);
  }
  if (minLng === maxLng) {
    minLng = clamp(minLng - 0.25, WORLD_MIN_LNG, WORLD_MAX_LNG);
    maxLng = clamp(maxLng + 0.25, WORLD_MIN_LNG, WORLD_MAX_LNG);
  }

  return {
    sw: [round2(minLat), round2(minLng)],
    ne: [round2(maxLat), round2(maxLng)],
  };
}

function bucketKey(count: number) {
  if (count >= 8) return "b8";
  if (count >= 4) return "b4";
  if (count >= 2) return "b2";
  return "b1";
}

function bucketColor(key: string) {
  if (key === "b8") return "#6D28D9"; // purple
  if (key === "b4") return "#06B6D4"; // cyan
  if (key === "b2") return "#F59E0B"; // amber
  return "#84CC16"; // lime
}

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeHttpsUrl(s: string) {
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
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

    // Fetch your own /api/network
    const base =
      process.env.NEXT_PUBLIC_URL && process.env.NEXT_PUBLIC_URL.startsWith("http")
        ? process.env.NEXT_PUBLIC_URL.replace(/\/+$/, "")
        : "";

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

    // username + pfp for overlays
    let username = "user";
    let pfpUrl = "";
    for (const p of pointsRaw) {
      const u = (p.users || []).find((x) => x?.fid === fid);
      if (u?.username) {
        username = u.username;
        if (u?.pfp_url) pfpUrl = u.pfp_url;
        break;
      }
    }
    const pfpSafe = safeHttpsUrl(pfpUrl);

    // Sort so bigger pins render on top
    const points = [...pointsRaw].sort((a, b) => (a.count || 0) - (b.count || 0));

    // Legend
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

    // Detect “world-ish” bounds (to avoid ultra-zoomed-out / duplicated world look)
    const worldish =
      !!bounds &&
      typeof (bounds as any)?.sw?.[1] === "number" &&
      typeof (bounds as any)?.ne?.[1] === "number" &&
      Math.abs((bounds as any).ne[1] - (bounds as any).sw[1]) > 300;

    const MIN_ZOOM_WORLD = 2;

    // IMPORTANT: no external Leaflet includes here.
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <style>
    :root{
      --purple:#cdb7ff;
      --card: rgba(255,255,255,0.35);
    }
    html, body {
      margin:0;
      padding:0;
      width:${w}px;
      height:${h}px;
      overflow:hidden;
      background: var(--purple);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
    }
    #frame{
      position:relative;
      width:100%;
      height:100%;
      padding: 14px;
      box-sizing:border-box;
      background: var(--purple);
    }
    #card{
      position:relative;
      width:100%;
      height:100%;
      border-radius: 28px;
      background: var(--card);
      box-shadow: 0 18px 60px rgba(0,0,0,0.22);
      overflow:hidden;
    }

    /* Map fills the FULL card space */
    #map{
      position:absolute;
      inset:0;
      width:100%;
      height:100%;
      background: rgba(0,0,0,0.05);
    }

    .overlay{ position:absolute; z-index:9999; pointer-events:none; }

    #legend{
      left: 18px;
      bottom: 18px;
      background: rgba(0,0,0,0.62);
      color: white;
      border-radius: 16px;
      padding: 12px 12px 10px 12px;
      width: 320px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.22);
    }
    #legendTitle{
      display:flex;
      justify-content:space-between;
      align-items:center;
      font-weight:900;
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
      width: 11px;
      height: 11px;
      border-radius: 999px;
      box-shadow: 0 0 0 2px rgba(0,0,0,0.35);
    }

    #watermark{
      right: 18px;
      bottom: 18px;
      background: rgba(0,0,0,0.62);
      color: white;
      border-radius: 999px;
      padding: 10px 14px;
      font-weight: 900;
      font-size: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.22);
    }

    #pfp{
      right: 18px;
      top: 18px;
      width: 120px;
      height: 120px;
      border-radius: 999px;
      background: rgba(0,0,0,0.35);
      box-shadow: 0 14px 50px rgba(0,0,0,0.25);
      display: grid;
      place-items: center;
      overflow:hidden;
    }
    #pfpInner{
      width: 112px;
      height: 112px;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
      overflow:hidden;
      box-shadow: inset 0 0 0 3px rgba(255,255,255,0.20);
      position:relative;
    }
    #pfpInner.hasImg{
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
    }
    #pfpFallback{
      position:absolute;
      inset:0;
      display:grid;
      place-items:center;
      color:white;
      font-weight:900;
      font-size:34px;
      letter-spacing: -0.5px;
      text-transform: uppercase;
      opacity:0.95;
    }

    /* Leaflet cleanup */
    .leaflet-control-container { display:none; }
    .leaflet-container { background: transparent; }
    .leaflet-tile { filter: saturate(1.05) contrast(1.03); }
  </style>
</head>
<body>
  <div id="frame">
    <div id="card">
      <div id="map"></div>

      <div id="legend" class="overlay">
        <div id="legendTitle">
          <div>Legend</div>
          <div style="opacity:0.9;font-weight:800">${legend.pins} pins • ${legend.users} users</div>
        </div>
        <div class="row">
          <div class="left"><span class="dot" style="background:${bucketColor("b1")}"></span>1 user</div>
          <div style="font-weight:900">${legend.b1} pins</div>
        </div>
        <div class="row">
          <div class="left"><span class="dot" style="background:${bucketColor("b2")}"></span>2–3 users</div>
          <div style="font-weight:900">${legend.b2} pins</div>
        </div>
        <div class="row">
          <div class="left"><span class="dot" style="background:${bucketColor("b4")}"></span>4–7 users</div>
          <div style="font-weight:900">${legend.b4} pins</div>
        </div>
        <div class="row">
          <div class="left"><span class="dot" style="background:${bucketColor("b8")}"></span>8+ users</div>
          <div style="font-weight:900">${legend.b8} pins</div>
        </div>
      </div>

      <div id="watermark" class="overlay">Far Maps • ${escHtml(String(username))}</div>

      <div id="pfp" class="overlay" aria-hidden="true">
        <div id="pfpInner" class="${pfpSafe ? "hasImg" : ""}" style="${
      pfpSafe ? `background-image:url('${pfpSafe.replace(/'/g, "%27")}')` : ""
    }">
          <div id="pfpFallback" style="${pfpSafe ? "display:none" : ""}">
            ${escHtml(String(username || "u").slice(0, 1))}
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    window.__MAP_READY__ = false;

    const points = ${JSON.stringify(
      points.map((p) => ({
        lat: clamp(Number(p.lat), WORLD_MIN_LAT, WORLD_MAX_LAT),
        lng: normalizeLng(Number(p.lng)),
        count: p.count || 1,
      }))
    )};

    const bounds = ${JSON.stringify(bounds)};
    const WORLDISH = ${JSON.stringify(worldish)};
    const MIN_ZOOM_WORLD = ${JSON.stringify(MIN_ZOOM_WORLD)};

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

    function radiusFor(count){
      if (count >= 8) return 7;
      if (count >= 4) return 6;
      if (count >= 2) return 5;
      return 4;
    }

    function initLeaflet(){
      try{
        if (!window.L) throw new Error("Leaflet not loaded");

        const WORLD_BOUNDS = L.latLngBounds(
          L.latLng(${WORLD_MIN_LAT}, ${WORLD_MIN_LNG}),
          L.latLng(${WORLD_MAX_LAT}, ${WORLD_MAX_LNG})
        );

        const map = L.map("map", {
          zoomControl:false,
          attributionControl:false,
          worldCopyJump:false,
          preferCanvas:true,
          maxBounds: WORLD_BOUNDS,
          maxBoundsViscosity: 1.0,
        });

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 8,
          minZoom: 1,
          noWrap: true,
          bounds: WORLD_BOUNDS,
        }).addTo(map);

        function applyView() {
          if (!points.length) {
            map.setView([20,0], 2);
            return;
          }
          if (bounds && bounds.sw && bounds.ne) {
            const b = L.latLngBounds(bounds.sw, bounds.ne);
            map.fitBounds(b, { padding:[10,10] });
            const z = map.getZoom();
            if (WORLDISH && z < MIN_ZOOM_WORLD) map.setZoom(MIN_ZOOM_WORLD);
            return;
          }
          map.setView([20,0], 2);
        }

        map.whenReady(() => {
          applyView();

          // force layout in headless
          requestAnimationFrame(() => {
            map.invalidateSize(true);
            requestAnimationFrame(() => {
              map.invalidateSize(true);

              // draw markers
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

              // settle then ready
              setTimeout(() => { window.__MAP_READY__ = true; }, 900);
            });
          });
        });

        // never hang
        setTimeout(() => { window.__MAP_READY__ = true; }, 6000);
      } catch (e) {
        window.__MAP_READY__ = true;
      }
    }

    window.__INIT_LEAFLET__ = initLeaflet;
  </script>
</body>
</html>`;

    // Puppeteer + Chromium
    const executablePath = await chromium.executablePath();
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: w, height: h },
      executablePath,
      headless: true,
    });

    try {
      const page = await browser.newPage();

      // Set HTML first (no external Leaflet)
      await page.setContent(html, { waitUntil: "domcontentloaded" });

      // Inject Leaflet from local node_modules (reliable)
      const leafletCssPath = require.resolve("leaflet/dist/leaflet.css");
      const leafletJsPath = require.resolve("leaflet/dist/leaflet.js");

      await page.addStyleTag({ path: leafletCssPath });
      await page.addScriptTag({ path: leafletJsPath });

      // Now run init inside the page
      await page.evaluate(() => {
        // @ts-ignore
        window.__INIT_LEAFLET__?.();
      });

      // Leaflet should mount
      await page.waitForSelector(".leaflet-pane", { timeout: 15_000 });

      // Wait until we're ready for screenshot
      await page.waitForFunction(() => (window as any).__MAP_READY__ === true, { timeout: 25_000 });

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

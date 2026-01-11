export const runtime = "nodejs";

import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function numParam(sp: URLSearchParams, key: string, fallback: number) {
  const v = sp.get(key);
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function strParam(sp: URLSearchParams, key: string, fallback: string) {
  const v = sp.get(key);
  return v == null ? fallback : v;
}

type Mode = "followers" | "following" | "both";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sp = url.searchParams;

    const fid = numParam(sp, "fid", NaN);
    if (!Number.isFinite(fid) || fid <= 0) {
      return NextResponse.json({ error: "Missing or invalid fid" }, { status: 400 });
    }

    const mode = (strParam(sp, "mode", "both") as Mode) || "both";
    const minScore = strParam(sp, "minScore", "0.8");
    const limitEach = strParam(sp, "limitEach", "800");
    const maxEach = strParam(sp, "maxEach", "5000");
    const concurrency = strParam(sp, "concurrency", "4");
    const hubPageSize = strParam(sp, "hubPageSize", "50");
    const hubDelayMs = strParam(sp, "hubDelayMs", "150");

    const w = Math.min(Math.max(numParam(sp, "w", 1000), 300), 2000);
    const h = Math.min(Math.max(numParam(sp, "h", 1000), 300), 2000);

    const origin = url.origin;

    // Fetch points server-side for a quick sanity check + to reduce failures
    // (But actual rendering HTML will fetch again so the map HTML stays “self-contained”.)
    const networkUrl =
      `${origin}/api/network?fid=${encodeURIComponent(String(fid))}` +
      `&mode=${encodeURIComponent(mode)}` +
      `&minScore=${encodeURIComponent(minScore)}` +
      `&limitEach=${encodeURIComponent(limitEach)}` +
      `&maxEach=${encodeURIComponent(maxEach)}` +
      `&concurrency=${encodeURIComponent(concurrency)}` +
      `&hubPageSize=${encodeURIComponent(hubPageSize)}` +
      `&hubDelayMs=${encodeURIComponent(hubDelayMs)}`;

    // Light preflight (optional but helps return clearer error early)
    {
      const r = await fetch(networkUrl, { cache: "no-store" });
      const text = await r.text();
      let j: any = null;
      try {
        j = text ? JSON.parse(text) : null;
      } catch {
        j = null;
      }
      if (!r.ok) {
        const msg = j?.error || `network fetch failed (${r.status})`;
        return NextResponse.json({ error: msg }, { status: 500 });
      }
    }

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link
      rel="stylesheet"
      href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
      crossorigin=""
    />
    <style>
      :root { --bg: #cdb7ff; }
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: var(--bg); }
      /* Frame */
      #frame {
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        padding: 18px;
        background: var(--bg);
        display: grid;
        place-items: center;
      }
      #card {
        width: 100%;
        height: 100%;
        border-radius: 22px;
        background: rgba(255,255,255,0.35);
        box-shadow: 0 18px 60px rgba(0,0,0,0.25);
        padding: 14px;
        box-sizing: border-box;
      }
      #mapWrap {
        width: 100%;
        height: 100%;
        border-radius: 18px;
        overflow: hidden;
        position: relative;
        background: #0000;
      }
      #map { width: 100%; height: 100%; }

      /* Watermark */
      #wm {
        position: absolute;
        right: 10px;
        bottom: 10px;
        z-index: 9999;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        font-weight: 800;
        font-size: 14px;
        padding: 7px 10px;
        border-radius: 999px;
        color: rgba(255,255,255,0.95);
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(6px);
        box-shadow: 0 10px 30px rgba(0,0,0,0.25);
      }

      /* Small “loading” */
      #status {
        position: absolute;
        left: 10px;
        top: 10px;
        z-index: 9999;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        font-size: 12px;
        font-weight: 800;
        padding: 7px 10px;
        border-radius: 999px;
        color: rgba(255,255,255,0.95);
        background: rgba(0,0,0,0.55);
      }

      /* Hide Leaflet UI */
      .leaflet-control-container { display: none !important; }
      .leaflet-attribution-flag { display: none !important; }
    </style>
  </head>
  <body>
    <div id="frame">
      <div id="card">
        <div id="mapWrap">
          <div id="status">Rendering…</div>
          <div id="wm">Far Maps • ${mode}</div>
          <div id="map"></div>
        </div>
      </div>
    </div>

    <script
      src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
      integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
      crossorigin=""
    ></script>

    <script>
      (async function () {
        const statusEl = document.getElementById("status");

        function setStatus(t){ statusEl.textContent = t; }

        const networkUrl = ${JSON.stringify(networkUrl)};
        setStatus("Fetching points…");

        const res = await fetch(networkUrl, { cache: "no-store" });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }

        const points = Array.isArray(json?.points) ? json.points : [];

        setStatus("Drawing map…");

        const map = L.map("map", {
          zoomControl: false,
          attributionControl: false,
          preferCanvas: true
        });

        // OSM tiles
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          crossOrigin: true
        }).addTo(map);

        // Color buckets that stand out
        function colorForCount(c){
          if (c >= 10) return "#ff3d81";  // hot pink
          if (c >= 5)  return "#00d4ff";  // cyan
          if (c >= 2)  return "#ffd84d";  // yellow
          return "#a8ff60";               // neon green
        }

        function radiusForCount(c){
          if (c >= 10) return 10;
          if (c >= 5)  return 8;
          if (c >= 2)  return 6;
          return 5;
        }

        const latlngs = [];
        for (const p of points) {
          if (typeof p?.lat !== "number" || typeof p?.lng !== "number") continue;

          const c = typeof p.count === "number" ? p.count : (Array.isArray(p.users) ? p.users.length : 1);
          const color = colorForCount(c);

          const marker = L.circleMarker([p.lat, p.lng], {
            radius: radiusForCount(c),
            color: "rgba(0,0,0,0.55)",      // outline
            weight: 2,
            fillColor: color,
            fillOpacity: 0.92
          });

          marker.addTo(map);
          latlngs.push([p.lat, p.lng]);
        }

        // ✅ SAME bounds behavior as your share-map-inner.tsx:
        // fitBounds with padding [30,30]
        if (!latlngs.length) {
          map.setView([20, 0], 2);
        } else {
          const bounds = L.latLngBounds(latlngs);
          map.fitBounds(bounds, { padding: [30, 30] });
        }

        // Wait until tiles/markers settle then signal puppeteer
        setStatus("Finalizing…");
        await new Promise((r) => setTimeout(r, 900));
        statusEl.style.display = "none";

        window.__FARMAPS_RENDER_DONE__ = true;
      })();
    </script>
  </body>
</html>`;

    const executablePath = await chromium.executablePath();

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: w, height: h },
      executablePath,
      headless: true,
    });

    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(60_000);

      // important: don’t hang waiting for “networkidle” because map tiles keep loading
      await page.setContent(html, { waitUntil: "domcontentloaded" });

      // Wait for our render completion flag
      for (let i = 0; i < 120; i++) {
        const done = await page.evaluate(() => (window as any).__FARMAPS_RENDER_DONE__ === true);
        if (done) break;
        await sleep(250);
      }

      // Screenshot only the framed area (full viewport here)
      const buf = await page.screenshot({ type: "png" });

      return new NextResponse(buf as any, {
        status: 200,
        headers: {
          "content-type": "image/png",
          // keep it cacheable but not forever (tunable)
          "cache-control": "public, max-age=60, s-maxage=300",
        },
      });
    } finally {
      await browser.close();
    }
  } catch (e: any) {
    console.error("api/map-image error:", e);
    return NextResponse.json(
      { error: e?.message || "map-image failed" },
      { status: 500 }
    );
  }
}

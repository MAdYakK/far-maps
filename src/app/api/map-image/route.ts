export const runtime = "nodejs";

import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

type Mode = "followers" | "following" | "both";

type NetworkResp = {
  fid: number;
  mode: Mode;
  minScore: number;
  limitEach: string | number;
  maxEach?: number;
  count: number;
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
  viewer?: {
    fid: number;
    username?: string;
    display_name?: string;
    pfp_url?: string;
  };
};

function num(sp: URLSearchParams, key: string, def: number) {
  const v = Number(sp.get(key));
  return Number.isFinite(v) ? v : def;
}

function str(sp: URLSearchParams, key: string, def: string) {
  return sp.get(key) ?? def;
}

function mode(sp: URLSearchParams, def: Mode): Mode {
  const m = (sp.get("mode") || def) as Mode;
  return m === "followers" || m === "following" || m === "both" ? m : def;
}

function getOriginFromReq(req: Request) {
  const host = req.headers.get("host") || "";
  const proto = host.includes("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  return `${proto}://${host}`;
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function legendBuckets(points: NetworkResp["points"]) {
  // buckets based on point.count
  const b = {
    one: 0,
    twoThree: 0,
    fourSeven: 0,
    eightPlus: 0,
  };

  for (const p of points) {
    if (p.count >= 8) b.eightPlus++;
    else if (p.count >= 4) b.fourSeven++;
    else if (p.count >= 2) b.twoThree++;
    else b.one++;
  }

  return b;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = url.searchParams;

  const fid = num(sp, "fid", NaN as any);
  if (!Number.isFinite(fid) || fid <= 0) {
    return NextResponse.json({ error: "Missing/invalid fid" }, { status: 400 });
  }

  const m = mode(sp, "both");
  const minScore = str(sp, "minScore", "0.8");
  const limitEach = str(sp, "limitEach", "800");
  const maxEach = str(sp, "maxEach", "5000");
  const concurrency = str(sp, "concurrency", "4");
  const hubPageSize = str(sp, "hubPageSize", "50");
  const hubDelayMs = str(sp, "hubDelayMs", "150");

  const w = Math.min(Math.max(num(sp, "w", 1000), 400), 1600);
  const h = Math.min(Math.max(num(sp, "h", 1000), 400), 1600);

  try {
    const origin = getOriginFromReq(req);

    const networkUrl =
      `${origin}/api/network?fid=${encodeURIComponent(String(fid))}` +
      `&mode=${encodeURIComponent(m)}` +
      `&minScore=${encodeURIComponent(minScore)}` +
      `&limitEach=${encodeURIComponent(limitEach)}` +
      `&maxEach=${encodeURIComponent(maxEach)}` +
      `&concurrency=${encodeURIComponent(concurrency)}` +
      `&hubPageSize=${encodeURIComponent(hubPageSize)}` +
      `&hubDelayMs=${encodeURIComponent(hubDelayMs)}`;

    const res = await fetch(networkUrl, { cache: "no-store" });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok || !json) {
      return NextResponse.json(
        { error: `network fetch failed (${res.status})`, detail: text?.slice?.(0, 400) },
        { status: 500 }
      );
    }

    const data = json as NetworkResp;

    const points = Array.isArray(data.points) ? data.points : [];
    // draw small first, big last (big on top)
    const ordered = [...points].sort((a, b) => a.count - b.count);

    const totalPins = ordered.length;
    const totalUsers = ordered.reduce((acc, p) => acc + (p.users?.length || 0), 0);

    const buckets = legendBuckets(ordered);

    const viewerName =
      data.viewer?.display_name ||
      data.viewer?.username ||
      (ordered.find((p) => p.users?.some((u) => u.fid === fid))?.users?.find((u) => u.fid === fid)
        ?.display_name ||
        ordered.find((p) => p.users?.some((u) => u.fid === fid))?.users?.find((u) => u.fid === fid)
          ?.username) ||
      `FID ${fid}`;

    const safeName = escapeHtml(viewerName);

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=${w}, height=${h}, initial-scale=1" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <style>
      html, body { margin:0; padding:0; width:${w}px; height:${h}px; overflow:hidden; background:#cdb7ff; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
      #frame {
        position: relative;
        width: ${w}px;
        height: ${h}px;
        background: #cdb7ff;
        display:flex;
        align-items:center;
        justify-content:center;
      }
      #card {
        position: relative;
        width: ${w}px;
        height: ${h}px;
        background: rgba(255,255,255,0.35);
        box-shadow: 0 18px 60px rgba(0,0,0,0.25);
        border-radius: 26px;
        padding: 14px;
        box-sizing: border-box;
      }
      #map {
        width: 100%;
        height: 100%;
        border-radius: 20px;
        overflow: hidden;
        background: rgba(0,0,0,0.12);
      }

      /* subtle vignette */
      #vignette {
        pointer-events:none;
        position:absolute;
        inset: 14px;
        border-radius: 20px;
        box-shadow: inset 0 0 0 1px rgba(0,0,0,0.10), inset 0 0 60px rgba(0,0,0,0.12);
      }

      #overlay {
        position: absolute;
        right: 28px;
        bottom: 28px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        align-items: flex-end;
        pointer-events: none;
      }

      .pill {
        background: rgba(0,0,0,0.70);
        color: white;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.2px;
        box-shadow: 0 10px 28px rgba(0,0,0,0.25);
        max-width: ${Math.min(w - 80, 520)}px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .legend {
        width: 260px;
        background: rgba(0,0,0,0.60);
        color: white;
        border-radius: 16px;
        padding: 10px 12px;
        box-shadow: 0 10px 28px rgba(0,0,0,0.25);
      }

      .legendTitle {
        font-weight: 800;
        font-size: 12px;
        opacity: 0.95;
        display:flex;
        justify-content: space-between;
        align-items: baseline;
      }

      .legendRow {
        margin-top: 8px;
        display:flex;
        justify-content: space-between;
        align-items:center;
        font-size: 12px;
        opacity: 0.95;
      }

      .left {
        display:flex;
        align-items:center;
        gap: 8px;
      }

      .dot {
        width: 14px;
        height: 14px;
        border-radius: 999px;
        border: 2px solid rgba(0,0,0,0.55);
        box-sizing: border-box;
      }

      .muted { opacity: 0.85; font-weight: 600; }
    </style>
  </head>
  <body>
    <div id="frame">
      <div id="card">
        <div id="map"></div>
        <div id="vignette"></div>

        <div id="overlay">
          <div class="pill">Far Maps • ${safeName}</div>

          <div class="legend">
            <div class="legendTitle">
              <span>Legend</span>
              <span class="muted">${totalPins} pins • ${totalUsers} users</span>
            </div>

            <div class="legendRow">
              <div class="left">
                <span class="dot" style="background:#84CC16;"></span>
                <span>1 user</span>
              </div>
              <span class="muted">${buckets.one} pins</span>
            </div>

            <div class="legendRow">
              <div class="left">
                <span class="dot" style="background:#F59E0B;"></span>
                <span>2–3 users</span>
              </div>
              <span class="muted">${buckets.twoThree} pins</span>
            </div>

            <div class="legendRow">
              <div class="left">
                <span class="dot" style="background:#06B6D4;"></span>
                <span>4–7 users</span>
              </div>
              <span class="muted">${buckets.fourSeven} pins</span>
            </div>

            <div class="legendRow">
              <div class="left">
                <span class="dot" style="background:#7C3AED;"></span>
                <span>8+ users</span>
              </div>
              <span class="muted">${buckets.eightPlus} pins</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script>
      const points = ${JSON.stringify(ordered)};

      const WORLD_BOUNDS = L.latLngBounds(
        L.latLng(-85, -180),
        L.latLng(85, 180)
      );

      function markerStyle(count) {
        if (count >= 8) return { r: 6, fill: "#7C3AED" };
        if (count >= 4) return { r: 5, fill: "#06B6D4" };
        if (count >= 2) return { r: 4, fill: "#F59E0B" };
        return { r: 3, fill: "#84CC16" };
      }

      const map = L.map("map", {
        zoomControl: false,
        attributionControl: false,
        worldCopyJump: false,
        maxBounds: WORLD_BOUNDS,
        maxBoundsViscosity: 1.0
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        noWrap: true,
        bounds: WORLD_BOUNDS
      }).addTo(map);

      // Same bounds logic as ShareMapInner:
      if (!points.length) {
        map.setView([20, 0], 2);
      } else if (points.length === 1) {
        map.setView([points[0].lat, points[0].lng], 4);
      } else {
        const b = L.latLngBounds(points.map(p => [p.lat, p.lng]));
        map.fitBounds(b, { padding: [30, 30] });
      }

      // Add markers (already ordered small->big so big is drawn last/top)
      for (const p of points) {
        const s = markerStyle(p.count);
        L.circleMarker([p.lat, p.lng], {
          radius: s.r,
          color: "rgba(0,0,0,0.55)",
          weight: 1.25,
          fillColor: s.fill,
          fillOpacity: 0.95
        }).addTo(map);
      }
    </script>
  </body>
</html>`;

    const executablePath = await chromium.executablePath();

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: true,
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });

      await page.setContent(html, { waitUntil: "networkidle2" });

      // Give tiles a moment to settle
      await new Promise((r) => setTimeout(r, 900));

      const png = await page.screenshot({ type: "png" });

      return new NextResponse(png as any, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-store, max-age=0",
        },
      });
    } finally {
      await browser.close();
    }
  } catch (e: any) {
    console.error("api/map-image error:", e);
    return NextResponse.json(
      { error: e?.message || "Server error", detail: String(e?.stack || "")?.slice?.(0, 1200) },
      { status: 500 }
    );
  }
}

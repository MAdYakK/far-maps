export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

type Mode = "followers" | "following" | "both";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getBaseUrl(req: Request) {
  // Prefer explicit URL if you have it, else infer from request
  const envUrl =
    process.env.NEXT_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_URL;

  if (envUrl) {
    const u = envUrl.startsWith("http") ? envUrl : `https://${envUrl}`;
    return u.replace(/\/+$/, "");
  }

  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg =
      json?.error ||
      json?.message ||
      `HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`;
    throw new Error(msg);
  }
  if (!json) throw new Error("Empty/non-JSON response");
  return json;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const fidStr = searchParams.get("fid");
    const fid = fidStr ? Number(fidStr) : NaN;
    if (!fidStr || !Number.isFinite(fid) || fid <= 0) {
      return NextResponse.json({ error: "Missing or invalid fid" }, { status: 400 });
    }

    const mode = (searchParams.get("mode") || "both") as Mode;
    if (mode !== "followers" && mode !== "following" && mode !== "both") {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }

    const minScore = Number(searchParams.get("minScore") || "0.8");
    const limitEach = searchParams.get("limitEach") || "800";
    const maxEach = searchParams.get("maxEach") || "5000";

    const w = Math.min(1600, Math.max(600, Number(searchParams.get("w") || "1000")));
    const h = Math.min(1600, Math.max(600, Number(searchParams.get("h") || "1000")));

    const baseUrl = getBaseUrl(req);

    // Pull points once (same data the share map uses)
    const networkUrl =
      `${baseUrl}/api/network` +
      `?fid=${encodeURIComponent(String(fid))}` +
      `&mode=${encodeURIComponent(mode)}` +
      `&minScore=${encodeURIComponent(String(minScore))}` +
      `&limitEach=${encodeURIComponent(String(limitEach))}` +
      `&maxEach=${encodeURIComponent(String(maxEach))}` +
      `&cacheBust=${Date.now()}`;

    const networkJson = await fetchJson(networkUrl, { cache: "no-store" });
    const points = Array.isArray(networkJson?.points) ? networkJson.points : [];

    // Build render-only share URL (no UI)
    const shareUrl =
      `${baseUrl}/share/map` +
      `?fid=${encodeURIComponent(String(fid))}` +
      `&mode=${encodeURIComponent(mode)}` +
      `&minScore=${encodeURIComponent(String(minScore))}` +
      `&limitEach=${encodeURIComponent(String(limitEach))}` +
      `&maxEach=${encodeURIComponent(String(maxEach))}` +
      `&w=${encodeURIComponent(String(w))}` +
      `&h=${encodeURIComponent(String(h))}` +
      `&renderOnly=1` +
      `&cacheBust=${Date.now()}`;

    // Launch headless chromium (Vercel-safe)
    const executablePath = await chromium.executablePath();

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: true,
      defaultViewport: { width: w, height: h, deviceScaleFactor: 2 },
    } as any);

    try {
      const page = await browser.newPage();

      // Reduce flaky renders
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        // Block heavy stuff we don't need
        const type = r.resourceType();
        if (type === "font") return r.abort();
        return r.continue();
      });

      await page.goto(shareUrl, { waitUntil: "networkidle2", timeout: 45_000 });

      // Wait for Leaflet bounds + rendering to finish
      await page.waitForFunction("window.__FARMAPS_MAP_READY__ === true", {
        timeout: 30_000,
      });

      // Screenshot ONLY the framed map area
      const el = await page.$("#farmaps-capture-frame");
      if (!el) throw new Error("Capture frame not found (#farmaps-capture-frame)");

      const png = (await el.screenshot({ type: "png" })) as Buffer;

      return new NextResponse(png, {
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
      {
        error: e?.message || "map-image failed",
      },
      { status: 500 }
    );
  }
}

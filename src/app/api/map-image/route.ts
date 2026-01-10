export const runtime = "nodejs";

import { NextResponse } from "next/server";
import chromium from "@sparticuz/chromium";
import playwright from "playwright-core";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // Pass-through params
  const fid = searchParams.get("fid");
  const mode = searchParams.get("mode") || "followers";
  const minScore = searchParams.get("minScore") || "0.8";
  const limitEach = searchParams.get("limitEach") || "all";
  const maxEach = searchParams.get("maxEach") || "20000";

  if (!fid) {
    return NextResponse.json({ error: "Missing fid" }, { status: 400 });
  }

  // Image size (good for sharing)
  const width = Number(searchParams.get("w") || "1200");
  const height = Number(searchParams.get("h") || "630");

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

  if (!baseUrl) {
    return NextResponse.json(
      { error: "Missing NEXT_PUBLIC_APP_URL (or VERCEL_URL)" },
      { status: 500 }
    );
  }

  const shareUrl =
    `${baseUrl}/share/map` +
    `?fid=${encodeURIComponent(fid)}` +
    `&mode=${encodeURIComponent(mode)}` +
    `&minScore=${encodeURIComponent(minScore)}` +
    `&limitEach=${encodeURIComponent(limitEach)}` +
    `&maxEach=${encodeURIComponent(maxEach)}`;

  let browser: any;
  try {
    browser = await playwright.chromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });

    await page.goto(shareUrl, { waitUntil: "networkidle", timeout: 45_000 });

    // Wait for Leaflet tiles to render something
    await page.waitForSelector(".leaflet-container", { timeout: 20_000 });
    await page.waitForTimeout(1200); // small settle time

    // Screenshot the full viewport (which is only the map)
    const png = await page.screenshot({ type: "png" });

    return new NextResponse(png as any, {
      status: 200,
      headers: {
        "content-type": "image/png",
        // CDN caching helps a ton for embeds
        "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (e: any) {
    console.error("map-image error:", e);
    return NextResponse.json({ error: e?.message || "Render failed" }, { status: 500 });
  } finally {
    if (browser) await browser.close();
  }
}

import { NextResponse } from "next/server";
import Irys from "@irys/sdk";

/**
 * Helper to require env vars
 */
function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * Build absolute base URL from request
 */
function getBaseUrl(req: Request) {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const fid = body?.fid;
    if (!fid) {
      return NextResponse.json({ error: "Missing fid" }, { status: 400 });
    }

    const mode = body?.mode ?? "both";
    const minScore = body?.minScore ?? "0.8";
    const limitEach = body?.limitEach ?? "800";
    const maxEach = body?.maxEach ?? "5000";
    const concurrency = body?.concurrency ?? "4";
    const hubPageSize = body?.hubPageSize ?? "50";
    const hubDelayMs = body?.hubDelayMs ?? "150";

    // ─────────────────────────────────────────────
    // 1) Generate the same map-image URL you use client-side
    // ─────────────────────────────────────────────
    const base = getBaseUrl(req);

    const mapUrl =
      `${base}/api/map-image` +
      `?fid=${encodeURIComponent(String(fid))}` +
      `&mode=${encodeURIComponent(mode)}` +
      `&minScore=${encodeURIComponent(minScore)}` +
      `&limitEach=${encodeURIComponent(limitEach)}` +
      `&maxEach=${encodeURIComponent(maxEach)}` +
      `&concurrency=${encodeURIComponent(concurrency)}` +
      `&hubPageSize=${encodeURIComponent(hubPageSize)}` +
      `&hubDelayMs=${encodeURIComponent(hubDelayMs)}` +
      `&w=1000&h=1000` +
      `&v=${Date.now()}`;

    // ─────────────────────────────────────────────
    // 2) Fetch PNG from map-image endpoint
    // ─────────────────────────────────────────────
    const pngRes = await fetch(mapUrl, { cache: "no-store" });
    if (!pngRes.ok) {
      const t = await pngRes.text().catch(() => "");
      return NextResponse.json(
        {
          error: "map-image failed",
          status: pngRes.status,
          detail: t.slice(0, 300),
        },
        { status: 500 }
      );
    }

    const pngBuffer = Buffer.from(await pngRes.arrayBuffer());

    // ─────────────────────────────────────────────
    // 3) Init Irys (Arweave uploader)
    // ─────────────────────────────────────────────
    const irys = new Irys({
      url: process.env.IRYS_NODE_URL || "https://node1.irys.xyz",
      token: mustEnv("IRYS_TOKEN"), // "ethereum"
      key: mustEnv("IRYS_PRIVATE_KEY"),
    });

    // ─────────────────────────────────────────────
    // 4) Upload image to Arweave
    // ─────────────────────────────────────────────
    const imgUpload = await irys.upload(pngBuffer, {
      tags: [
        { name: "Content-Type", value: "image/png" },
        { name: "App-Name", value: "FarMaps" },
        { name: "Type", value: "farmap-image" },
        { name: "FID", value: String(fid) },
      ],
    });

    const imageId = imgUpload.id;
    const imageUrl = `https://arweave.net/${imageId}`;

    // ─────────────────────────────────────────────
    // 5) Build NFT metadata
    // ─────────────────────────────────────────────
    const metadata = {
      name: `FarMap (FID ${fid})`,
      description: "Your Farcaster network visualized on a world map.",
      image: imageUrl,
      external_url: "https://far-maps.vercel.app",
      attributes: [
        { trait_type: "FID", value: String(fid) },
        { trait_type: "Mode", value: String(mode) },
        { trait_type: "Min Score", value: String(minScore) },
      ],
    };

    // ─────────────────────────────────────────────
    // 6) Upload metadata JSON to Arweave
    // ─────────────────────────────────────────────
    const metaUpload = await irys.upload(JSON.stringify(metadata), {
      tags: [
        { name: "Content-Type", value: "application/json" },
        { name: "App-Name", value: "FarMaps" },
        { name: "Type", value: "farmap-metadata" },
        { name: "FID", value: String(fid) },
      ],
    });

    const metadataId = metaUpload.id;
    const metadataUrl = `https://arweave.net/${metadataId}`;

    // ─────────────────────────────────────────────
    // 7) Return info needed for mint
    // ─────────────────────────────────────────────
    return NextResponse.json({
      ok: true,
      tokenURI: metadataUrl,
      metadataUrl,
      imageUrl,
      price: Number(process.env.NEXT_PUBLIC_MINT_PRICE || "1000000"), // 1 USDC (6 decimals)
    });
  } catch (e: any) {
    console.error("mint/prepare error:", e);
    return NextResponse.json(
      { error: e?.message || "Mint prepare failed" },
      { status: 500 }
    );
  }
}

// src/app/api/mint/prepare/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { Uploader } from "@irys/upload";
import { BaseEth } from "@irys/upload-ethereum";

const VERSION = "prepare-route-v3-reqid-baseurl-rawbody";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

type PrepareBody = {
  fid?: any;
  username?: any; // optional
  [k: string]: any;
};

function gatewaysFor(id: string) {
  return {
    irysGateway: `https://gateway.irys.xyz/${id}`,
    irysNode1: `https://node1.irys.xyz/${id}`,
    irysNode2: `https://node2.irys.xyz/${id}`,
    arweaveNet: `https://arweave.net/${id}`,
    arIo: `https://ar-io.dev/${id}`,
  };
}

// ✅ Restore FID rarity buckets
function fidRarity(fid: number): string {
  if (fid >= 1 && fid <= 100) return "First 100";
  if (fid <= 1_000) return "sub 1k";
  if (fid <= 10_000) return "sub 10k";
  if (fid <= 20_000) return "sub 20k";
  if (fid <= 50_000) return "sub 50k";
  if (fid <= 100_000) return "sub 100k";
  if (fid <= 500_000) return "sub 500k";
  if (fid <= 1_000_000) return "sub 1m";
  return "1m+";
}

// Normalize anything numeric-ish to bigint
function toBigInt(v: any): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.floor(v));
  if (typeof v === "string") return BigInt(v);
  if (v && typeof v.toString === "function") return BigInt(v.toString());
  throw new Error(`Unable to convert to bigint: ${String(v)}`);
}

// Handle SDK differences (getter vs function)
async function readIrysAddress(irys: any): Promise<string> {
  const a = irys.address;
  return typeof a === "function" ? String(await a.call(irys)) : String(a);
}

async function readLoadedBalance(irys: any): Promise<bigint> {
  const fn = irys.getLoadedBalance;
  if (typeof fn === "function") return toBigInt(await fn.call(irys));
  return toBigInt(irys.loadedBalance ?? irys.balance);
}

function normalizeFid(v: any): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0) return null;
  return i;
}

function normalizeUsername(v: any): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function getBaseUrl(req: Request) {
  const env = process.env.NEXT_PUBLIC_URL?.trim();
  if (env && env.startsWith("http")) return env.replace(/\/+$/, "");

  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`.replace(/\/+$/, "");

  return "";
}

function json(data: any, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "cache-control": "no-store, no-cache, must-revalidate, max-age=0" },
  });
}

// Optional: simple GET to confirm deploy
export async function GET(req: Request) {
  return json({
    ok: true,
    route: "api/mint/prepare",
    version: VERSION,
    baseUrl: getBaseUrl(req),
    methods: ["POST"],
  });
}

export async function POST(req: Request) {
  const reqId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();

  // Use console.error so it reliably shows in Vercel logs
  console.error("[mint/prepare] HIT", {
    reqId,
    version: VERSION,
    url: req.url,
    contentType: req.headers.get("content-type"),
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    ua: (req.headers.get("user-agent") ?? "").slice(0, 120),
  });

  // Read raw body once (more robust in embedded webviews)
  const raw = await req.text();

  let body: PrepareBody | null = null;
  let parseError: string | null = null;

  try {
    body = raw ? (JSON.parse(raw) as PrepareBody) : null;
  } catch (e: any) {
    parseError = e?.message ?? String(e);
  }

  if (!body) {
    console.error("[mint/prepare] invalid json", { reqId, parseError, raw: raw?.slice(0, 400) });
    return json(
      {
        reqId,
        ok: false,
        version: VERSION,
        error: "Invalid JSON body",
        parseError,
        rawBody: (raw ?? "").slice(0, 1200),
      },
      400
    );
  }

  try {
    const fid = normalizeFid(body?.fid);
    const username = normalizeUsername(body?.username);

    if (!fid) {
      return json(
        {
          reqId,
          ok: false,
          version: VERSION,
          error: "Missing or invalid `fid`",
          receivedFidType: typeof body?.fid,
          receivedFid: body?.fid,
          rawBody: (raw ?? "").slice(0, 1200),
        },
        400
      );
    }

    const rarity = fidRarity(fid);

    // 1) Fetch PNG from existing generator
    const baseUrl = getBaseUrl(req);
    if (!baseUrl) {
      return json(
        {
          reqId,
          ok: false,
          version: VERSION,
          error: "Could not determine base URL (set NEXT_PUBLIC_URL)",
        },
        500
      );
    }

    const imageUrl = `${baseUrl}/api/map-image?fid=${encodeURIComponent(String(fid))}&mode=both&w=1000&h=1000&v=${Date.now()}`;

    const imgRes = await fetch(imageUrl, { cache: "no-store" });
    if (!imgRes.ok) {
      const t = await imgRes.text().catch(() => "");
      return json(
        {
          reqId,
          ok: false,
          version: VERSION,
          error: "Failed to generate image",
          status: imgRes.status,
          detail: t.slice(0, 600),
          imageUrl,
          baseUrl,
        },
        502
      );
    }

    const pngBuffer = Buffer.from(await imgRes.arrayBuffer());

    // 2) Init Irys (Base) + force RPC
    const irys = await Uploader(BaseEth).withRpc(mustEnv("BASE_RPC_URL")).withWallet(mustEnv("IRYS_PRIVATE_KEY"));

    const addr = await readIrysAddress(irys);
    let loadedBal = await readLoadedBalance(irys);

    console.error("[irys] address:", addr);
    console.error("[irys] loaded balance:", loadedBal.toString());

    // 3) Estimate cost
    const pngPrice = toBigInt(await irys.getPrice(pngBuffer.length));

    const metaEstimate = {
      name: `Far Map #${fid}`,
      description: "A map of your Farcaster network generated by Far Maps.",
      image: "https://gateway.irys.xyz/<txid>",
      external_url: "https://far-maps.vercel.app",
      attributes: [
        { trait_type: "FID", value: fid },
        { trait_type: "FID Rarity", value: rarity }, // ✅ added back
        ...(username ? [{ trait_type: "Username", value: username }] : []),
      ],
    };

    const metaBytes = Buffer.byteLength(JSON.stringify(metaEstimate), "utf8");
    const metaPrice = toBigInt(await irys.getPrice(metaBytes));

    const totalNeeded = ((pngPrice + metaPrice) * BigInt(110)) / BigInt(100); // +10% buffer

    // 4) Auto-fund if needed
    if (loadedBal < totalNeeded) {
      const toFund = totalNeeded - loadedBal;
      console.error("[irys] funding:", toFund.toString());

      const fundRes = await irys.fund(toFund);
      console.error("[irys] fund tx:", (fundRes as any)?.id ?? fundRes);

      loadedBal = await readLoadedBalance(irys);
      console.error("[irys] balance after fund:", loadedBal.toString());
    }

    // 5) Upload PNG
    const imgReceipt = await irys.upload(pngBuffer, {
      tags: [
        { name: "Content-Type", value: "image/png" },
        { name: "App-Name", value: "FarMaps" },
        { name: "Type", value: "Farmap" },
        { name: "FID", value: String(fid) },
        { name: "FID-Rarity", value: rarity }, // ✅ added back
        ...(username ? [{ name: "Username", value: username }] : []),
      ],
    });

    const imgUrls = gatewaysFor(imgReceipt.id);

    // 6) Upload metadata
    const metadata = {
      name: `Far Map #${fid}`,
      description: "A map of your Farcaster network generated by Far Maps.",
      image: imgUrls.irysGateway,
      external_url: "https://far-maps.vercel.app",
      attributes: [
        { trait_type: "FID", value: fid },
        { trait_type: "FID Rarity", value: rarity }, // ✅ added back
        ...(username ? [{ trait_type: "Username", value: username }] : []),
      ],
    };

    const metaReceipt = await irys.upload(JSON.stringify(metadata), {
      tags: [
        { name: "Content-Type", value: "application/json" },
        { name: "App-Name", value: "FarMaps" },
        { name: "Type", value: "Metadata" },
        { name: "FID", value: String(fid) },
        { name: "FID-Rarity", value: rarity }, // ✅ added back
        ...(username ? [{ name: "Username", value: username }] : []),
      ],
    });

    const metaUrls = gatewaysFor(metaReceipt.id);

    return json({
      reqId,
      ok: true,
      version: VERSION,
      fid,
      username,
      rarity, // ✅ handy debug field (optional, but nice)
      imageUrl: imgUrls.irysGateway,
      tokenUri: metaUrls.irysGateway,
      imgTx: imgReceipt.id,
      metaTx: metaReceipt.id,
      imageUrls: imgUrls,
      tokenUriUrls: metaUrls,
      // helpful trace
      baseUrl,
      generatorUrl: imageUrl,
    });
  } catch (e: any) {
    console.error("mint/prepare error:", e);
    return json(
      {
        reqId,
        ok: false,
        version: VERSION,
        error: e?.message || "Server error",
        detail: String(e?.stack || "").slice(0, 2000),
      },
      500
    );
  }
}

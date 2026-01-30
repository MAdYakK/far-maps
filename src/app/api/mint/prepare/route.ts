// src/app/api/mint/prepare/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { Uploader } from "@irys/upload";
import { BaseEth } from "@irys/upload-ethereum";

const VERSION = "prepare-route-v6-warmup-gateway-no-ar-io-dev";

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
    arIo: `https://ar-io.net/${id}`, // ✅ FIXED (was ar-io.dev)
  };
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
  let s = v.trim();
  if (!s) return undefined;
  if (s.startsWith("@")) s = s.slice(1);
  return s || undefined;
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

// ✅ FID rarity bucketing per your rules
function fidRarity(fid: number): string {
  if (fid >= 1 && fid <= 100) return "First 100";
  if (fid >= 101 && fid <= 1000) return "sub 1k";
  if (fid >= 1001 && fid <= 10000) return "sub 10k";
  if (fid >= 10001 && fid <= 20000) return "sub 20k";
  if (fid >= 20001 && fid <= 50000) return "sub 50k";
  if (fid >= 50001 && fid <= 100000) return "sub 100k";
  if (fid >= 100001 && fid <= 500000) return "sub 500k";
  if (fid >= 500001 && fid <= 1000000) return "sub 1m";
  return "1m+";
}

// ✅ Optional server-side username backfill (only if NEYNAR_API_KEY is present)
async function tryFetchUsernameFromFid(fid: number): Promise<string | undefined> {
  const key = process.env.NEYNAR_API_KEY?.trim();
  if (!key) return undefined;

  try {
    const r = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`, {
      headers: { api_key: key },
      cache: "no-store",
    });

    const j = await r.json().catch(() => null);
    const u = j?.users?.[0]?.username;
    return typeof u === "string" && u.trim() ? u.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function fetchWithTimeout(url: string, ms = 3500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { method: "GET", signal: ac.signal, cache: "no-store" as any });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// ✅ Warm up gateway propagation for immediate Warpcast/OpenSea fetch
async function warmupPublicRead(id: string) {
  const g = gatewaysFor(id);
  const urls = [g.irysGateway, g.irysNode1, g.irysNode2, g.arIo, g.arweaveNet];

  for (let i = 0; i < 5; i++) {
    for (const u of urls) {
      try {
        const res = await fetchWithTimeout(u, 3500);
        if (res.ok) {
          // read a little to encourage caching
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            await res.text();
          } else {
            const reader = res.body?.getReader?.();
            if (reader) {
              await reader.read();
              try {
                reader.releaseLock();
              } catch {}
            }
          }
          return { ok: true, url: u };
        }
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 400 + i * 250));
  }
  return { ok: false };
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

  console.error("[mint/prepare] HIT", {
    reqId,
    version: VERSION,
    url: req.url,
    contentType: req.headers.get("content-type"),
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    ua: (req.headers.get("user-agent") ?? "").slice(0, 120),
  });

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
    const usernameFromBody = normalizeUsername(body?.username);

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

    // ✅ Determine base URL
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

    // ✅ Instant image generator URL (always available to share)
    const generatorUrl = `${baseUrl}/api/map-image?fid=${encodeURIComponent(
      String(fid)
    )}&mode=both&w=1000&h=1000&v=${Date.now()}`;

    // 1) Fetch PNG from generator
    const imgRes = await fetch(generatorUrl, { cache: "no-store" });
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
          generatorUrl,
          baseUrl,
        },
        502
      );
    }

    const pngBuffer = Buffer.from(await imgRes.arrayBuffer());

    // 2) Init Irys (Base) + force RPC
    const irys = await Uploader(BaseEth)
      .withRpc(mustEnv("BASE_RPC_URL"))
      .withWallet(mustEnv("IRYS_PRIVATE_KEY"));

    const addr = await readIrysAddress(irys);
    let loadedBal = await readLoadedBalance(irys);

    console.error("[irys] address:", addr);
    console.error("[irys] loaded balance:", loadedBal.toString());

    // ✅ Username final (client-provided OR Neynar backfill)
    const finalUsername = usernameFromBody ?? (await tryFetchUsernameFromFid(fid));

    // 3) Estimate cost
    const pngPrice = toBigInt(await irys.getPrice(pngBuffer.length));

    const metaEstimate = {
      name: `Far Map #${fid}`,
      description: "A map of your Farcaster network generated by Far Maps.",
      image: "https://gateway.irys.xyz/<txid>",
      image_url: "https://gateway.irys.xyz/<txid>",
      external_url: MINIAPP_LINK,
      attributes: [
        { trait_type: "FID", value: fid },
        { trait_type: "FID Rarity", value: rarity },
        ...(finalUsername ? [{ trait_type: "Farcaster", value: finalUsername }] : []),
      ],
      properties: {
        image_fallbacks: {},
      },
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
        { name: "FID-Rarity", value: rarity },
        ...(finalUsername ? [{ name: "Farcaster", value: finalUsername }] : []),
      ],
    });

    const imgUrls = gatewaysFor(imgReceipt.id);

    // ✅ warm up image
    await warmupPublicRead(imgReceipt.id);

    // 6) Upload metadata (Buffer + fallbacks)
    const metadata = {
      name: finalUsername ? `Far Map — @${finalUsername}` : `Far Map #${fid}`,
      description: "A map of your Farcaster network generated by Far Maps.",
      image: imgUrls.irysGateway,
      image_url: imgUrls.irysGateway, // ✅ helps some indexers
      external_url: MINIAPP_LINK, // ✅ miniapp link, not just your vercel site
      attributes: [
        { trait_type: "FID", value: fid },
        { trait_type: "FID Rarity", value: rarity },
        ...(finalUsername ? [{ trait_type: "Farcaster", value: finalUsername }] : []),
      ],
      properties: {
        image_fallbacks: imgUrls, // ✅ redundancy without breaking OpenSea
        fid,
        username: finalUsername || undefined,
      },
    };

    const metaReceipt = await irys.upload(Buffer.from(JSON.stringify(metadata)), {
      tags: [
        { name: "Content-Type", value: "application/json" },
        { name: "App-Name", value: "FarMaps" },
        { name: "Type", value: "Metadata" },
        { name: "FID", value: String(fid) },
        { name: "FID-Rarity", value: rarity },
        ...(finalUsername ? [{ name: "Farcaster", value: finalUsername }] : []),
      ],
    });

    const metaUrls = gatewaysFor(metaReceipt.id);

    // ✅ warm up metadata
    await warmupPublicRead(metaReceipt.id);

    // ✅ Response should also use gateway (instant)
    return json({
      reqId,
      ok: true,
      version: VERSION,
      fid,
      username: finalUsername,
      fidRarity: rarity,

      // ✅ instant + reliable URLs
      imageUrl: imgUrls.irysGateway,
      tokenUri: metaUrls.irysGateway,

      imgTx: imgReceipt.id,
      metaTx: metaReceipt.id,
      imageUrls: imgUrls,
      tokenUriUrls: metaUrls,

      baseUrl,
      generatorUrl,
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

// keep this at file scope
const MINIAPP_LINK = "https://farcaster.xyz/miniapps/g1hRkzaqCGOG/farmaps";

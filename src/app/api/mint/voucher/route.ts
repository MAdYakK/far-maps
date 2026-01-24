// src/app/api/mint/voucher/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // ✅ avoid any caching weirdness

import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const VERSION = "voucher-route-v5-query-fallback"; // 👈 bump on redeploy

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

type Body = {
  mintAttemptId?: any;
  to?: any;
  tokenUri?: any;
  tokenURI?: any;
  deadlineSeconds?: any;
  [k: string]: any;
};

function normalizeAddress(input: any): `0x${string}` | null {
  let v: any = input;

  for (let i = 0; i < 6; i++) {
    if (!v) return null;

    if (typeof v === "string") break;

    if (Array.isArray(v)) {
      v = v[0];
      continue;
    }

    if (typeof v === "object") {
      v = v.address ?? v.account ?? v.value ?? v.owner ?? v.to ?? v?.[0];
      continue;
    }

    return null;
  }

  if (typeof v !== "string") return null;

  const s = v.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  return s as `0x${string}`;
}

function normalizeTokenUri(body: Body): string {
  const raw =
    typeof body.tokenUri === "string"
      ? body.tokenUri
      : typeof body.tokenURI === "string"
        ? body.tokenURI
        : "";
  return raw.trim();
}

const CONTRACT_ABI = parseAbi([
  "function nonces(address) view returns (uint256)",
  "function mintPrice() view returns (uint256)",
]);

export async function POST(req: Request) {
  // read raw once
  const raw = await req.text();

  const attemptIdHeader = req.headers.get("x-mint-attempt-id") ?? "(none)";
  const contentType = req.headers.get("content-type") ?? "(none)";
  const origin = req.headers.get("origin") ?? "(none)";
  const referer = req.headers.get("referer") ?? "(none)";
  const ua = (req.headers.get("user-agent") ?? "(none)").slice(0, 160);

  const walletHdr = req.headers.get("x-wallet-address") ?? "";

  let body: Body | null = null;
  let parseError: string | null = null;

  try {
    body = raw ? (JSON.parse(raw) as Body) : null;
  } catch (e: any) {
    parseError = e?.message ?? String(e);
  }

  const mintAttemptId = String(body?.mintAttemptId ?? attemptIdHeader ?? "(none)");

  // ✅ ALSO accept query params (Warpcast-safe)
  const url = new URL(req.url);
  const qTo = url.searchParams.get("to") ?? "";
  const qTokenUri = url.searchParams.get("tokenUri") ?? url.searchParams.get("tokenURI") ?? "";

  // If JSON invalid/empty, still allow query params to work
  if (!body) body = {} as Body;

  // Determine tokenUri from body OR query
  const tokenUri = (normalizeTokenUri(body) || qTokenUri || "").trim();

  // Determine `to` from body OR query OR header
  const to =
    normalizeAddress(body?.to) ||
    normalizeAddress(qTo) ||
    normalizeAddress(walletHdr);

  const deadlineSeconds =
    typeof body?.deadlineSeconds === "number" && body.deadlineSeconds > 0
      ? Math.floor(body.deadlineSeconds)
      : 15 * 60;

  // Helpful debug fields
  const receivedTo = body?.to;
  const receivedToType =
    receivedTo === null ? "null" : Array.isArray(receivedTo) ? "array" : typeof receivedTo;

  const receivedToPreview = (() => {
    try {
      if (typeof receivedTo === "string") return receivedTo.slice(0, 140);
      return JSON.stringify(receivedTo)?.slice(0, 280);
    } catch {
      return String(receivedTo).slice(0, 280);
    }
  })();

  if (parseError) {
    console.log("[mint/voucher] json parse error", {
      VERSION,
      mintAttemptId,
      parseError,
      raw: raw?.slice(0, 400),
      qTo: qTo.slice(0, 80),
      qTokenUri: qTokenUri.slice(0, 120),
      contentType,
      origin,
      referer,
      ua,
    });
  }

  if (!to) {
    return NextResponse.json(
      {
        version: VERSION,
        error: "Missing or invalid `to`",
        mintAttemptId,
        receivedToType,
        receivedTo: receivedToPreview,
        qToPreview: qTo ? qTo.slice(0, 140) : "(none)",
        walletHdrPreview: walletHdr ? walletHdr.slice(0, 140) : "(none)",
        tokenUriPreview: tokenUri ? tokenUri.slice(0, 160) : "(none)",
        contentType,
        origin,
        referer,
        ua,
        rawBody: (raw ?? "").slice(0, 1200),
        hint: "Send ?to=0x...&tokenUri=... (Warpcast-safe).",
      },
      { status: 400 }
    );
  }

  if (!tokenUri) {
    return NextResponse.json(
      {
        version: VERSION,
        error: "Missing `tokenUri`",
        mintAttemptId,
        hint: "Send ?to=0x...&tokenUri=https://... (Warpcast-safe).",
      },
      { status: 400 }
    );
  }

  try {
    const contract = mustEnv("FARMAPS_CONTRACT") as `0x${string}`;
    const rpcUrl = mustEnv("BASE_RPC_URL");
    const pk = mustEnv("VOUCHER_SIGNER_PRIVATE_KEY");

    const signerAccount = privateKeyToAccount(
      (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`
    );

    const client = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });

    const [nonce, price] = await Promise.all([
      client.readContract({
        address: contract,
        abi: CONTRACT_ABI,
        functionName: "nonces",
        args: [to],
      }),
      client.readContract({
        address: contract,
        abi: CONTRACT_ABI,
        functionName: "mintPrice",
        args: [],
      }),
    ]);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

    const voucher = {
      to,
      tokenURI: tokenUri,
      price,
      nonce,
      deadline,
    } as const;

    const domain = {
      name: "Far Maps",
      version: "1",
      chainId: base.id,
      verifyingContract: contract,
    } as const;

    const types = {
      MintVoucher: [
        { name: "to", type: "address" },
        { name: "tokenURI", type: "string" },
        { name: "price", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    } as const;

    const signature = await signerAccount.signTypedData({
      domain,
      types,
      primaryType: "MintVoucher",
      message: voucher,
    });

    return NextResponse.json({
      version: VERSION,
      ok: true,
      mintAttemptId,
      voucher: {
        to: voucher.to,
        tokenURI: voucher.tokenURI,
        price: voucher.price.toString(),
        nonce: voucher.nonce.toString(),
        deadline: voucher.deadline.toString(),
      },
      signature,
    });
  } catch (e: any) {
    console.error("mint/voucher error:", e);
    return NextResponse.json(
      {
        version: VERSION,
        error: e?.message || "Server error",
        mintAttemptId,
        detail: String(e?.stack || "").slice(0, 2000),
      },
      { status: 500 }
    );
  }
}

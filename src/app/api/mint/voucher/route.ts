// src/app/api/mint/voucher/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const VERSION = "voucher-route-v3-debug-top"; // 👈 change this string if you redeploy again

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
  // Read raw body once
  const raw = await req.text();

  const attemptIdHeader = req.headers.get("x-mint-attempt-id") ?? "(none)";
  const contentType = req.headers.get("content-type") ?? "(none)";
  const origin = req.headers.get("origin") ?? "(none)";
  const referer = req.headers.get("referer") ?? "(none)";
  const ua = (req.headers.get("user-agent") ?? "(none)").slice(0, 160);

  let body: Body | null = null;
  let parseError: string | null = null;

  try {
    body = raw ? (JSON.parse(raw) as Body) : null;
  } catch (e: any) {
    parseError = e?.message ?? String(e);
  }

  const mintAttemptId = String(body?.mintAttemptId ?? attemptIdHeader ?? "(none)");

  const receivedTo = body?.to;
  const receivedToType =
    receivedTo === null
      ? "null"
      : Array.isArray(receivedTo)
        ? "array"
        : typeof receivedTo;

  const receivedToPreview = (() => {
    try {
      if (typeof receivedTo === "string") return receivedTo.slice(0, 140);
      return JSON.stringify(receivedTo)?.slice(0, 280);
    } catch {
      return String(receivedTo).slice(0, 280);
    }
  })();

  // If JSON is invalid/empty, surface that immediately
  if (!body) {
    console.log("[mint/voucher] invalid json", {
      VERSION,
      mintAttemptId,
      parseError,
      raw: raw?.slice(0, 400),
      contentType,
      origin,
      referer,
      ua,
    });

    return NextResponse.json(
      {
        version: VERSION,
        error: "Invalid JSON body",
        mintAttemptId,
        parseError,
        contentType,
        origin,
        referer,
        ua,
        rawBody: (raw ?? "").slice(0, 1200),
      },
      { status: 400 }
    );
  }

  const to = normalizeAddress(body?.to);
  const tokenUri = normalizeTokenUri(body);

  const deadlineSeconds =
    typeof body?.deadlineSeconds === "number" && body.deadlineSeconds > 0
      ? Math.floor(body.deadlineSeconds)
      : 15 * 60;

  if (!to) {
    console.log("[mint/voucher] missing/invalid to", {
      VERSION,
      mintAttemptId,
      receivedToType,
      receivedToPreview,
      raw: raw?.slice(0, 400),
      contentType,
      origin,
      referer,
      ua,
    });

    // 👇 IMPORTANT: put debug at top-level so your UI shows it even if it only reads {error: ...}
    return NextResponse.json(
      {
        version: VERSION,
        error: "Missing or invalid `to`",
        mintAttemptId,
        receivedToType,
        receivedTo: receivedToPreview,
        contentType,
        origin,
        referer,
        ua,
        rawBody: (raw ?? "").slice(0, 1200),
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
        hint: "Send JSON { to: '0x..', tokenUri: 'https://...' }",
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

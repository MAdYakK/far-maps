// src/app/api/mint/voucher/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * We accept a few possible shapes because different callers/providers
 * sometimes send odd payloads.
 */
type Body = {
  mintAttemptId?: any;
  to?: any;
  tokenUri?: any;
  tokenURI?: any;
  deadlineSeconds?: any;
  // allow other keys without failing
  [k: string]: any;
};

// ✅ Deep address normalizer: unwraps nested objects/arrays a few levels
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
      v =
        v.address ??
        v.account ??
        v.value ??
        v.owner ??
        v.to ??
        v?.[0];
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
  // Capture useful request metadata + raw body for Warpcast debugging
  const attemptIdHeader = req.headers.get("x-mint-attempt-id") ?? "(none)";
  const contentType = req.headers.get("content-type") ?? "(none)";
  const origin = req.headers.get("origin") ?? "(none)";
  const referer = req.headers.get("referer") ?? "(none)";
  const ua = req.headers.get("user-agent") ?? "(none)";

  const raw = await req.text();

  let body: Body | null = null;
  let parseError: string | null = null;

  try {
    body = raw ? (JSON.parse(raw) as Body) : null;
  } catch (e: any) {
    parseError = e?.message ?? String(e);
  }

  const mintAttemptId = (body?.mintAttemptId ?? attemptIdHeader ?? "(none)") as string;

  const debug = {
    mintAttemptId,
    headers: {
      contentType,
      origin,
      referer,
      ua: ua.slice(0, 160),
    },
    parseError,
    rawBody: (raw ?? "").slice(0, 2000),
    receivedToType:
      body?.to === null
        ? "null"
        : Array.isArray(body?.to)
          ? "array"
          : typeof body?.to,
    receivedTo: (() => {
      try {
        if (typeof body?.to === "string") return body.to.slice(0, 140);
        return JSON.stringify(body?.to)?.slice(0, 280);
      } catch {
        return String(body?.to).slice(0, 280);
      }
    })(),
  };

  try {
    if (!body) {
      console.log("[mint/voucher] invalid json", debug);
      return NextResponse.json(
        { error: "Invalid JSON body", debug },
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
      console.log("[mint/voucher] missing/invalid to", { ...debug, extractedTo: null });
      return NextResponse.json(
        {
          error: "Missing or invalid `to`",
          debug: { ...debug, extractedTo: null },
        },
        { status: 400 }
      );
    }

    if (!tokenUri) {
      console.log("[mint/voucher] missing tokenUri", { ...debug, extractedTo: to });
      return NextResponse.json(
        {
          error: "Missing `tokenUri`",
          hint: "Send JSON { to: '0x..', tokenUri: 'https://...' }",
          debug: { ...debug, extractedTo: to },
        },
        { status: 400 }
      );
    }

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

    // Must match contract: EIP712("Far Maps", "1")
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

    console.log("[mint/voucher] ok", { ...debug, extractedTo: to });

    return NextResponse.json({
      ok: true,
      voucher: {
        to: voucher.to,
        tokenURI: voucher.tokenURI,
        price: voucher.price.toString(),
        nonce: voucher.nonce.toString(),
        deadline: voucher.deadline.toString(),
      },
      signature,
      // Keep debug for now until you confirm Warpcast is sending correct payload
      debug: { ...debug, extractedTo: to },
    });
  } catch (e: any) {
    console.error("mint/voucher error:", e, debug);
    return NextResponse.json(
      {
        error: e?.message || "Server error",
        detail: String(e?.stack || "").slice(0, 2000),
        debug,
      },
      { status: 500 }
    );
  }
}

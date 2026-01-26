// src/app/api/mint/voucher/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // ✅ avoid any caching weirdness

import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbi, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const VERSION = "voucher-route-v5-reqid-errlog-recover-to";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

type Body = {
  mintAttemptId?: any;

  // legacy / optional
  to?: any;

  // required
  tokenUri?: any;
  tokenURI?: any;

  // optional: used when `to` is missing
  message?: any;
  signature?: any;

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

function normalizeSig(v: any): `0x${string}` | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(s)) return null;
  return s as `0x${string}`;
}

const CONTRACT_ABI = parseAbi([
  "function nonces(address) view returns (uint256)",
  "function mintPrice() view returns (uint256)",
]);

export async function POST(req: Request) {
  // ✅ reqId for cross-checking in UI + Vercel logs
  const reqId =
    (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();

  // ✅ Use console.error so it reliably shows in Vercel logs
  console.error("[mint/voucher] HIT", {
    reqId,
    url: req.url,
    method: "POST",
    contentType: req.headers.get("content-type"),
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    ua: (req.headers.get("user-agent") ?? "").slice(0, 120),
  });

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

  // If JSON is invalid/empty, surface immediately
  if (!body) {
    console.error("[mint/voucher] invalid json", {
      reqId,
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
        reqId,
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

  const tokenUri = normalizeTokenUri(body);

  const deadlineSeconds =
    typeof body?.deadlineSeconds === "number" && body.deadlineSeconds > 0
      ? Math.floor(body.deadlineSeconds)
      : 15 * 60;

  if (!tokenUri) {
    return NextResponse.json(
      {
        reqId,
        version: VERSION,
        error: "Missing `tokenUri`",
        mintAttemptId,
        hint: "Send JSON { tokenUri: 'https://...' } (and optionally message+signature).",
      },
      { status: 400 }
    );
  }

  // 1) Prefer explicit `to` if present
  let to = normalizeAddress(body?.to);

  // 2) If missing, recover from signature
  let recoveredTo: `0x${string}` | null = null;
  const msg = typeof body?.message === "string" ? body.message : null;
  const sig = normalizeSig(body?.signature);

  if (!to && msg && sig) {
    try {
      recoveredTo = await recoverMessageAddress({
        message: msg,
        signature: sig,
      });
      to = recoveredTo;
    } catch (e: any) {
      console.error("[mint/voucher] recover failed", {
        reqId,
        VERSION,
        mintAttemptId,
        err: e?.message ?? String(e),
      });
    }
  }

  // If still missing, error with debug
  if (!to) {
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

    console.error("[mint/voucher] missing/invalid to", {
      reqId,
      VERSION,
      mintAttemptId,
      receivedToType,
      receivedToPreview,
      hasMessage: !!msg,
      hasSignature: !!sig,
      contentType,
      origin,
      referer,
      ua,
      raw: raw?.slice(0, 400),
    });

    return NextResponse.json(
      {
        reqId,
        version: VERSION,
        error: "Missing or invalid `to` (and could not recover from signature)",
        mintAttemptId,
        receivedToType,
        receivedTo: receivedToPreview,
        hasMessage: !!msg,
        hasSignature: !!sig,
        contentType,
        origin,
        referer,
        ua,
        rawBody: (raw ?? "").slice(0, 1200),
      },
      { status: 400 }
    );
  }

  // If both are present, make sure recovered matches provided `to`
  if (recoveredTo && body?.to) {
    const explicit = normalizeAddress(body.to);
    if (explicit && explicit.toLowerCase() !== recoveredTo.toLowerCase()) {
      return NextResponse.json(
        {
          reqId,
          version: VERSION,
          error: "Signature address does not match `to`",
          mintAttemptId,
          explicitTo: explicit,
          recoveredTo,
        },
        { status: 400 }
      );
    }
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

    return NextResponse.json({
      reqId,
      version: VERSION,
      ok: true,
      mintAttemptId,
      to,
      recoveredTo,
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
        reqId,
        version: VERSION,
        error: e?.message || "Server error",
        mintAttemptId,
        detail: String(e?.stack || "").slice(0, 2000),
      },
      { status: 500 }
    );
  }
}

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
  to?: any;
  tokenUri?: any;
  tokenURI?: any;
  deadlineSeconds?: any;
  // allow other keys without failing
  [k: string]: any;
};

function normalizeAddress(input: any): `0x${string}` | null {
  let v: any = input;

  // Common alternate shapes
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === "object") v = v.address ?? v.account ?? v.value ?? v?.[0];

  if (typeof v !== "string") return null;

  const s = v.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;

  return s as `0x${string}`;
}

function normalizeTokenUri(body: Body): string {
  const raw = typeof body.tokenUri === "string" ? body.tokenUri : typeof body.tokenURI === "string" ? body.tokenURI : "";
  return raw.trim();
}

const CONTRACT_ABI = parseAbi([
  "function nonces(address) view returns (uint256)",
  "function mintPrice() view returns (uint256)",
]);

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const to = normalizeAddress(body?.to);
    const tokenUri = normalizeTokenUri(body);

    const deadlineSeconds =
      typeof body?.deadlineSeconds === "number" && body.deadlineSeconds > 0
        ? Math.floor(body.deadlineSeconds)
        : 15 * 60;

    if (!to) {
      // ✅ Return a helpful error showing what we received (trimmed)
      return NextResponse.json(
        {
          error: "Missing or invalid `to`",
          receivedToType: typeof body?.to,
          receivedTo: (() => {
            try {
              if (typeof body?.to === "string") return body.to.slice(0, 120);
              return JSON.stringify(body?.to)?.slice(0, 240);
            } catch {
              return String(body?.to).slice(0, 240);
            }
          })(),
        },
        { status: 400 }
      );
    }

    if (!tokenUri) {
      return NextResponse.json(
        {
          error: "Missing `tokenUri`",
          hint: "Send JSON { to: '0x..', tokenUri: 'https://...' }",
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
    });
  } catch (e: any) {
    console.error("mint/voucher error:", e);
    return NextResponse.json(
      { error: e?.message || "Server error", detail: String(e?.stack || "").slice(0, 2000) },
      { status: 500 }
    );
  }
}

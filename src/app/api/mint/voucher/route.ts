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

type Body = {
  to: `0x${string}`;
  tokenUri: string;
  deadlineSeconds?: number;
};

const CONTRACT_ABI = parseAbi([
  "function nonces(address) view returns (uint256)",
  "function mintPrice() view returns (uint256)",
]);

function isAddress(a: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const to = body?.to;
    const tokenUri = typeof body?.tokenUri === "string" ? body.tokenUri.trim() : "";
    const deadlineSeconds =
      typeof body?.deadlineSeconds === "number" && body.deadlineSeconds > 0
        ? Math.floor(body.deadlineSeconds)
        : 15 * 60;

    if (!to || !isAddress(to)) {
      return NextResponse.json({ error: "Missing or invalid `to`" }, { status: 400 });
    }
    if (!tokenUri) {
      return NextResponse.json({ error: "Missing `tokenUri`" }, { status: 400 });
    }

    // Optional safety: prevent signing arbitrary URLs (tighten as you like)
    // if (!tokenUri.startsWith("https://gateway.irys.xyz/") && !tokenUri.startsWith("https://node1.irys.xyz/")) {
    //   return NextResponse.json({ error: "tokenUri must be an Irys URL" }, { status: 400 });
    // }

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

    // Get exact nonce + mint price onchain
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

    // Message fields MUST match Solidity struct field names/types
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

    // ✅ BigInt-safe JSON response (your client expects strings)
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
      signer: signerAccount.address,
      contract,
      chainId: base.id,
    });
  } catch (e: any) {
    console.error("mint/voucher error:", e);
    return NextResponse.json(
      { error: e?.message || "Server error", detail: String(e?.stack || "").slice(0, 2000) },
      { status: 500 }
    );
  }
}

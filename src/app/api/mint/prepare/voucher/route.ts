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
  // Who receives the NFT
  to: `0x${string}`;

  // The tokenURI returned by /api/mint/prepare
  tokenUri: string;

  // Optional: override price/deadline seconds (usually omit)
  deadlineSeconds?: number;
};

const CONTRACT_ABI = parseAbi([
  "function nonces(address) view returns (uint256)",
  "function mintPrice() view returns (uint256)",
]);

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const to = body?.to;
    const tokenUri = typeof body?.tokenUri === "string" ? body.tokenUri.trim() : "";
    const deadlineSeconds =
      typeof body?.deadlineSeconds === "number" && body.deadlineSeconds > 0
        ? Math.floor(body.deadlineSeconds)
        : 15 * 60; // 15 minutes default

    if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
      return NextResponse.json({ error: "Missing or invalid `to`" }, { status: 400 });
    }
    if (!tokenUri) {
      return NextResponse.json({ error: "Missing `tokenUri`" }, { status: 400 });
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

    // Pull the exact nonce + current mint price from chain
    const [nonce, price] = await Promise.all([
      client.readContract({ address: contract, abi: CONTRACT_ABI, functionName: "nonces", args: [to] }),
      client.readContract({ address: contract, abi: CONTRACT_ABI, functionName: "mintPrice", args: [] }),
    ]);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

    // This matches Solidity:
    // struct MintVoucher { address to; string tokenURI; uint256 price; uint256 nonce; uint256 deadline; }
    const voucher = {
      to,
      tokenURI: tokenUri,
      price,     // uint256
      nonce,     // uint256
      deadline,  // uint256
    } as const;

    // EIP712("Far Maps", "1")
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
      voucher,
      signature,
      // Useful for UI
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

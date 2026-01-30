"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { sdk } from "@farcaster/miniapp-sdk";

import { createPublicClient, createWalletClient, custom, http } from "viem";
import { base } from "viem/chains";
import { erc20Abi } from "viem";

// ─────────────────────────────────────────────
// CONFIG — set these to your deployed values
// ─────────────────────────────────────────────
const CONTRACT_ADDRESS = "0x13096b5cc02913579b2be3FE9B69a2FEfa87820c" as const;

// Base USDC (6 decimals)
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// ─────────────────────────────────────────────
// DEV MODE (toggle on/off)
// ─────────────────────────────────────────────
const DEV_MODE = false; // ✅ set true ONLY while debugging
const DEV_MULTI_MINT_ADDRESS = "0xfa3Ce274F05bB01B8dC85a9DFF96CaE8c5c869e6" as const;

// Miniapp link to include in shares
const MINIAPP_LINK = "https://farcaster.xyz/miniapps/g1hRkzaqCGOG/farmaps";

// FarMapsMint ABI (only what we need)
const farMapsMintAbi = [
  {
    type: "function",
    name: "mintPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "mintWithVoucher",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "v",
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "tokenURI", type: "string" },
          { name: "price", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "sig", type: "bytes" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

type Mode = "followers" | "following" | "both";

function getBaseUrl() {
  const env = process.env.NEXT_PUBLIC_URL;
  if (env && env.startsWith("http")) return env.replace(/\/+$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

type PrepareResp = {
  ok: true;
  fid: number;
  username?: string;
  imageUrl: string;
  tokenUri: string;
  imgTx: string;
  metaTx: string;
  imageUrls?: Record<string, string>;
  tokenUriUrls?: Record<string, string>;
};

function shortAddr(a?: string) {
  if (!a) return "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function isAddress(a: any): a is `0x${string}` {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

function normalizeAddr(v: any): `0x${string}` | null {
  let s: any = null;

  if (typeof v === "string") s = v;
  else if (Array.isArray(v)) s = v[0];
  else if (v && typeof v === "object") s = (v as any).address ?? (v as any).account ?? (v as any)?.[0];

  if (!s) return null;

  const trimmed = String(s).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
}

export default function ShareMapPage() {
  const router = useRouter();

  const [fid, setFid] = useState<number | null>(null);
  const [username, setUsername] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("both");

  const [minScore, setMinScore] = useState("0.8");
  const [limitEach, setLimitEach] = useState("800");
  const [maxEach, setMaxEach] = useState("5000");
  const [concurrency, setConcurrency] = useState("4");
  const [hubPageSize, setHubPageSize] = useState("50");
  const [hubDelayMs, setHubDelayMs] = useState("150");

  const [imgOk, setImgOk] = useState<boolean | null>(null);
  const [imgErr, setImgErr] = useState<string>("");

  const [loadingImg, setLoadingImg] = useState(true);
  const [reloadNonce] = useState<number>(() => Date.now());

  // Mint UI
  const [minting, setMinting] = useState(false);
  const [mintStage, setMintStage] = useState<string>("");
  const [mintErr, setMintErr] = useState<string>("");
  const [mintedTokenUri, setMintedTokenUri] = useState<string>("");
  const [mintedImageUrl, setMintedImageUrl] = useState<string>("");
  const [mintTxHash, setMintTxHash] = useState<string>("");

  // Share popup after mint
  const [sharePopupOpen, setSharePopupOpen] = useState(false);
  const [sharingMinted, setSharingMinted] = useState(false);

  // Already minted overlay
  const [alreadyMintedOpen, setAlreadyMintedOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const sp = new URLSearchParams(window.location.search);

      const qFid = sp.get("fid");
      const qMode = (sp.get("mode") as Mode | null) ?? null;

      if (qMode === "followers" || qMode === "following" || qMode === "both") setMode(qMode);

      if (sp.get("minScore")) setMinScore(sp.get("minScore")!);
      if (sp.get("limitEach")) setLimitEach(sp.get("limitEach")!);
      if (sp.get("maxEach")) setMaxEach(sp.get("maxEach")!);
      if (sp.get("concurrency")) setConcurrency(sp.get("concurrency")!);
      if (sp.get("hubPageSize")) setHubPageSize(sp.get("hubPageSize")!);
      if (sp.get("hubDelayMs")) setHubDelayMs(sp.get("hubDelayMs")!);

      if (qFid && Number.isFinite(Number(qFid))) {
        setFid(Number(qFid));
        return;
      }

      try {
        await sdk.actions.ready();
        const ctx = await sdk.context;

        const detectedFid =
          ((ctx as any)?.viewer?.fid as number | undefined) ??
          ((ctx as any)?.user?.fid as number | undefined);

        const detectedUsername =
          (ctx as any)?.viewer?.username ??
          (ctx as any)?.user?.username ??
          (ctx as any)?.viewer?.user?.username ??
          (ctx as any)?.user?.user?.username;

        if (detectedFid) setFid(detectedFid);
        if (typeof detectedUsername === "string" && detectedUsername.trim()) {
          setUsername(detectedUsername.trim());
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  const imageSrc = useMemo(() => {
    if (!fid) return "";
    return (
      `/api/map-image` +
      `?fid=${encodeURIComponent(String(fid))}` +
      `&mode=${encodeURIComponent(mode)}` +
      `&minScore=${encodeURIComponent(minScore)}` +
      `&limitEach=${encodeURIComponent(limitEach)}` +
      `&maxEach=${encodeURIComponent(maxEach)}` +
      `&concurrency=${encodeURIComponent(concurrency)}` +
      `&hubPageSize=${encodeURIComponent(hubPageSize)}` +
      `&hubDelayMs=${encodeURIComponent(hubDelayMs)}` +
      `&w=1000&h=1000` +
      `&v=${encodeURIComponent(String(reloadNonce))}`
    );
  }, [fid, mode, minScore, limitEach, maxEach, concurrency, hubPageSize, hubDelayMs, reloadNonce]);

  const imageAbsolute = useMemo(() => {
    if (!fid) return "";
    const baseUrl = getBaseUrl();
    if (!baseUrl) return "";
    return `${baseUrl}${imageSrc.startsWith("/") ? "" : "/"}${imageSrc}`;
  }, [fid, imageSrc]);

  async function shareMintedCast() {
    if (!mintedImageUrl) return;

    try {
      setSharingMinted(true);
      await sdk.actions.composeCast({
        text: "I got my FarMap! Check out yours!",
        embeds: [mintedImageUrl, MINIAPP_LINK],
      });
      setSharePopupOpen(false);
    } catch (e: any) {
      setMintErr(e?.message || "Failed to share");
    } finally {
      setSharingMinted(false);
    }
  }

  // Used only for the "Already minted" overlay (shares the current map image)
  async function shareCurrentMapCast() {
    if (!imageAbsolute) return;

    try {
      setSharingMinted(true);
      await sdk.actions.composeCast({
        text: "I got my FarMap! Check out yours!",
        embeds: [imageAbsolute, MINIAPP_LINK],
      });
      setAlreadyMintedOpen(false);
    } catch (e: any) {
      setMintErr(e?.message || "Failed to share");
    } finally {
      setSharingMinted(false);
    }
  }

  async function mintNow() {
    if (!fid) return;

    setMintErr("");
    setMintStage("");
    setMintedTokenUri("");
    setMintedImageUrl("");
    setMintTxHash("");
    setSharePopupOpen(false);

    try {
      setMinting(true);
      setMintStage("Connecting wallet…");

      const ethProvider = await sdk.wallet.getEthereumProvider();

      const walletClient = createWalletClient({
        chain: base,
        transport: custom(ethProvider as any),
      });

      const rpc = process.env.NEXT_PUBLIC_BASE_RPC_URL?.trim() || "https://mainnet.base.org";
      const publicClient = createPublicClient({
        chain: base,
        transport: http(rpc),
      });

      // Get account robustly
      let account: `0x${string}` | null = null;

      try {
        const addrs = await walletClient.getAddresses();
        account = normalizeAddr(addrs);
      } catch {}

      if (!account) {
        try {
          const accts = await (ethProvider as any).request?.({ method: "eth_accounts", params: [] });
          account = normalizeAddr(accts);
        } catch {}
      }

      if (!account) {
        try {
          const requested = await (ethProvider as any).request?.({
            method: "eth_requestAccounts",
            params: [],
          });
          account = normalizeAddr(requested);
        } catch {}
      }

      if (!account) {
        throw new Error("No wallet address returned from provider (eth_accounts / eth_requestAccounts).");
      }
      if (!isAddress(account)) {
        throw new Error(`Invalid wallet address from provider: ${String(account)}`);
      }

      // 1 mint per wallet for everyone except DEV (only if DEV_MODE is true)
      const isDev = DEV_MODE && account.toLowerCase() === DEV_MULTI_MINT_ADDRESS.toLowerCase();

      setMintStage(isDev ? "Dev mode: skipping 1-per-wallet check…" : "Checking mint status…");

      if (!isDev) {
        const bal = await publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: farMapsMintAbi,
          functionName: "balanceOf",
          args: [account],
        });

        if (bal > BigInt(0)) {
          setMintStage("");
          setAlreadyMintedOpen(true);
          return;
        }
      }

      // Prepare (upload png + metadata)
      setMintStage("Preparing metadata…");
      const prepRes = await fetch("/api/mint/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ fid, username }),
      });

      const prepText = await prepRes.text();
      const prepJson = prepText ? (JSON.parse(prepText) as PrepareResp) : null;
      if (!prepRes.ok || !prepJson?.ok) {
        throw new Error(prepJson ? JSON.stringify(prepJson) : "Prepare failed");
      }

      const tokenUri = prepJson.tokenUri;
      const imgUrl = prepJson.imageUrl;

      // Voucher auth (user signature)
      setMintStage("Authorizing mint…");

      const mintAttemptId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();

      const message =
        `FarMaps mint authorization\n` +
        `mintAttemptId: ${mintAttemptId}\n` +
        `tokenUri: ${tokenUri}\n` +
        `timestamp: ${Date.now()}`;

      let userSig: `0x${string}` | null = null;
      try {
        userSig = (await walletClient.signMessage({
          account,
          message,
        })) as `0x${string}`;
      } catch (e: any) {
        throw new Error(e?.message || "User signature rejected");
      }

      setMintStage("Fetching voucher…");

      const baseUrl = getBaseUrl();
      if (!baseUrl) throw new Error("Missing baseUrl (NEXT_PUBLIC_URL or window.location.origin)");

      const vRes = await fetch(`${baseUrl}/api/mint/voucher?cb=${encodeURIComponent(mintAttemptId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-mint-attempt-id": mintAttemptId,
        },
        cache: "no-store",
        body: JSON.stringify({
          mintAttemptId,
          to: String(account).trim(),
          tokenUri,
          message,
          signature: userSig,
        }),
      });

      const vText = await vRes.text();
      let vJson: any = null;
      try {
        vJson = vText ? JSON.parse(vText) : null;
      } catch {}

      if (!vRes.ok || !vJson?.ok) {
        const detail = vText ? vText.slice(0, 1200) : `HTTP ${vRes.status}`;
        throw new Error(`Voucher failed: ${detail}`);
      }

      // Sanity: voucher.to must equal our wallet
      if (String(vJson?.voucher?.to || "").toLowerCase() !== account.toLowerCase()) {
        throw new Error(`Voucher mismatch: voucher.to=${vJson?.voucher?.to} but wallet=${account}`);
      }

      // Approve USDC (if needed)
      setMintStage("Approving USDC…");
      const onchainPrice = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: farMapsMintAbi,
        functionName: "mintPrice",
      });

      const allowance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, CONTRACT_ADDRESS],
      });

      if (allowance < onchainPrice) {
        const approveHash = await walletClient.writeContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [CONTRACT_ADDRESS, onchainPrice],
          account,
        });

        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      // Mint
      setMintStage("Minting…");
      const hash = await walletClient.writeContract({
        address: CONTRACT_ADDRESS,
        abi: farMapsMintAbi,
        functionName: "mintWithVoucher",
        args: [
          {
            to: vJson.voucher.to,
            tokenURI: vJson.voucher.tokenURI,
            price: BigInt(vJson.voucher.price),
            nonce: BigInt(vJson.voucher.nonce),
            deadline: BigInt(vJson.voucher.deadline),
          },
          vJson.signature,
        ],
        account,
      });

      await publicClient.waitForTransactionReceipt({ hash });

      setMintedTokenUri(tokenUri);
      setMintedImageUrl(imgUrl);
      setMintTxHash(hash as unknown as string);
      setMintStage(`Minted! Tx ${shortAddr(hash as any)}`);

      // open share popup instead of auto-sharing
      setSharePopupOpen(true);
    } catch (e: any) {
      setMintErr(e?.message || "Mint failed");
      setMintStage("");
    } finally {
      setMinting(false);
    }
  }

  const topRightLabel = useMemo(() => {
    if (!fid) return "Loading…";
    const who = username?.trim() ? username.trim() : mode;
    return `FID ${fid} • ${who}`;
  }, [fid, username, mode]);

  return (
    <main
      style={{
        height: "100vh",
        width: "100vw",
        margin: 0,
        padding: 0,
        overflow: "hidden",
        background: "#cdb7ff",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bar */}
      <div style={{ position: "relative", zIndex: 10, padding: 12 }}>
        <div
          style={{
            borderRadius: 14,
            background: "rgba(0,0,0,0.55)",
            color: "white",
            padding: 10,
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <BubbleButton onClick={() => router.push("/")}>Home</BubbleButton>

          <BubbleButton onClick={mintNow} disabled={!fid || minting || imgOk === false || loadingImg}>
            {minting ? "Minting…" : "Mint"}
          </BubbleButton>

          <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.9 }}>{topRightLabel}</div>

          {mintStage ? (
            <div style={{ width: "100%", fontSize: 12, opacity: 0.95, marginTop: 4 }}>{mintStage}</div>
          ) : null}

          {mintErr ? (
            <div style={{ width: "100%", fontSize: 12, color: "#ffb4b4", marginTop: 4 }}>{mintErr}</div>
          ) : null}

          {mintedTokenUri ? (
            <div style={{ width: "100%", fontSize: 12, opacity: 0.9, marginTop: 4 }}>
              TokenURI: {mintedTokenUri}
              {mintedImageUrl ? (
                <>
                  <br />
                  Image: {mintedImageUrl}
                </>
              ) : null}
              {mintTxHash ? (
                <>
                  <br />
                  Tx: {shortAddr(mintTxHash)}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Image area */}
      <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 16 }}>
        <div
          style={{
            width: "min(92vw, 560px)",
            aspectRatio: "1 / 1",
            borderRadius: 18,
            overflow: "hidden",
            boxShadow: "0 14px 50px rgba(0,0,0,0.25)",
            position: "relative",
            background: "rgba(0,0,0,0.10)",
          }}
        >
          {!fid ? (
            <div
              style={{
                height: "100%",
                width: "100%",
                display: "grid",
                placeItems: "center",
                color: "rgba(0,0,0,0.75)",
                fontWeight: 800,
              }}
            >
              Loading…
            </div>
          ) : (
            <>
              <img
                src={imageSrc}
                alt="Farmap"
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                onLoad={() => {
                  setImgOk(true);
                  setImgErr("");
                  setLoadingImg(false);
                }}
                onError={() => {
                  setImgOk(false);
                  setImgErr("Map image failed to load (api/map-image returned an error).");
                  setLoadingImg(false);
                }}
              />

              {/* Loading overlay */}
              {loadingImg && <OverlayCard title="Loading Farmap" subtitle="Loading map image…" />}

              {/* ✅ Already minted overlay (click/tap anywhere on it to share) */}
              {alreadyMintedOpen && (
                <OverlayCard
                  title="ALREADY MINTED!"
                  subtitle="Tap to share your FarMap!"
                  onClose={() => setAlreadyMintedOpen(false)}
                  onClick={() => {
                    void shareCurrentMapCast();
                  }}
                />
              )}

              {/* Share popup after mint */}
              {sharePopupOpen && mintedImageUrl ? (
                <CenterBubblePopup
                  title="Mint complete!"
                  subtitle="Want to share it?"
                  primaryText={sharingMinted ? "Sharing…" : "Share my FarMap!"}
                  onPrimary={shareMintedCast}
                  onClose={() => setSharePopupOpen(false)}
                />
              ) : null}

              {/* Error overlay */}
              {imgOk === false ? (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    zIndex: 30,
                    display: "grid",
                    placeItems: "center",
                    padding: 14,
                    textAlign: "center",
                    background: "rgba(255,255,255,0.85)",
                    color: "#2b1b55",
                    fontWeight: 800,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14 }}>{imgErr}</div>
                    <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, opacity: 0.9 }}>
                      Try again in a moment (hub/Neynar can rate-limit).
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function BubbleButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!disabled}
      style={{
        border: "1px solid rgba(255,255,255,0.22)",
        background: disabled ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.18)",
        color: "white",
        padding: "7px 12px",
        borderRadius: 999,
        fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        userSelect: "none",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

function CenterBubblePopup({
  title,
  subtitle,
  primaryText,
  onPrimary,
  onClose,
}: {
  title: string;
  subtitle?: string;
  primaryText: string;
  onPrimary: () => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "grid",
        placeItems: "center",
        padding: 16,
        background: "rgba(0,0,0,0.25)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(92%, 420px)",
          borderRadius: 16,
          background: "rgba(0,0,0,0.55)",
          color: "white",
          padding: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 900 }}>{title}</div>
          <div style={{ marginLeft: "auto" }}>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              style={{
                width: 26,
                height: 26,
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.25)",
                background: "rgba(255,255,255,0.10)",
                color: "white",
                cursor: "pointer",
                lineHeight: "24px",
                fontWeight: 800,
              }}
            >
              ×
            </button>
          </div>
        </div>

        {subtitle ? <div style={{ fontSize: 12, opacity: 0.9 }}>{subtitle}</div> : null}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <BubbleButton onClick={onPrimary}>{primaryText}</BubbleButton>
          <BubbleButton onClick={onClose}>Not now</BubbleButton>
        </div>
      </div>
    </div>
  );
}

function OverlayCard({
  title,
  subtitle,
  onClick,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClick?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        background: "rgba(0,0,0,0.35)",
        display: "grid",
        placeItems: "center",
        padding: 14,
        cursor: onClick ? "pointer" : "default",
      }}
      onClick={() => {
        if (onClick) onClick();
      }}
    >
      <div
        style={{
          width: 320,
          borderRadius: 16,
          background: "rgba(0,0,0,0.65)",
          color: "white",
          padding: 14,
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
          position: "relative",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {onClose ? (
          <button
            type="button"
            aria-label="Close"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              width: 26,
              height: 26,
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.25)",
              background: "rgba(255,255,255,0.10)",
              color: "white",
              cursor: "pointer",
              lineHeight: "24px",
              fontWeight: 800,
            }}
          >
            ×
          </button>
        ) : null}

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 999,
              border: "3px solid rgba(255,255,255,0.25)",
              borderTopColor: "white",
              animation: "spin 0.9s linear infinite",
              opacity: onClick ? 0.0 : 1,
            }}
          />
          <div style={{ fontWeight: 800 }}>{title}</div>
        </div>

        {subtitle ? <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>{subtitle}</div> : null}

        <style jsx global>{`
          @keyframes spin {
            to {
              transform: rotate(360deg);
            }
          }
        `}</style>
      </div>
    </div>
  );
}

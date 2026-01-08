import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure scrapers (Warpcast/Farcaster) receive a fully-rendered <head>
  // instead of streamed metadata that may omit fc:miniapp at fetch time.
  htmlLimitedBots: /Farcaster|Warpcast|MiniApp|bot|crawler|spider/i,
};

export default nextConfig;

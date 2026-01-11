import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ✅ Important: ensure these stay as external node_modules so chromium's bin files exist at runtime
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],
};

export default nextConfig;

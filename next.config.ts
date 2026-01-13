import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],

  outputFileTracingIncludes: {
    "/api/map-image": [
      "./node_modules/@sparticuz/chromium/bin/**",
      "./node_modules/@sparticuz/chromium/build/**",
      "./node_modules/leaflet/dist/**",
    ],
    "app/api/map-image": [
      "./node_modules/@sparticuz/chromium/bin/**",
      "./node_modules/@sparticuz/chromium/build/**",
      "./node_modules/leaflet/dist/**",
    ],
  },
};

export default nextConfig;

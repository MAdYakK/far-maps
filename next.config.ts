// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],

  experimental: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...( {
      outputFileTracingIncludes: {
        "/api/map-image": [
          "./node_modules/@sparticuz/chromium/bin/**",
          "./node_modules/@sparticuz/chromium/build/**",
        ],
        "app/api/map-image": [
          "./node_modules/@sparticuz/chromium/bin/**",
          "./node_modules/@sparticuz/chromium/build/**",
        ],
      },
    } as any ),
  },
};

export default nextConfig;

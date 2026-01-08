import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "leaflet/dist/leaflet.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

function getBaseUrl() {
  return (process.env.NEXT_PUBLIC_URL || "https://far-maps.vercel.app").replace(/\/$/, "");
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const baseUrl = getBaseUrl();

  const miniapp = {
    version: "1",
    imageUrl: `${baseUrl}/embed.png`,
    button: {
      title: "Open Far Maps",
      action: {
        type: "launch_miniapp",
        url: `${baseUrl}/`,
        name: "Far Maps",
      },
    },
  };

  const content = JSON.stringify(miniapp);

  return (
    <html lang="en">
      <head>
        <title>Far Maps</title>
        <meta
          name="description"
          content="Map your Farcaster followers + following by city"
        />

        {/* ✅ Farcaster mini app embed */}
        <meta name="fc:miniapp" content={content} />
        <meta name="fc:frame" content={content} />

        {/* Optional (helps many scrapers/tools) */}
        <meta property="og:title" content="Far Maps" />
        <meta
          property="og:description"
          content="Map your Farcaster followers + following by city"
        />
        <meta property="og:image" content={`${baseUrl}/embed.png`} />
      </head>

      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}

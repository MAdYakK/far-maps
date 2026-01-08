export default function Head() {
  const baseUrl = (process.env.NEXT_PUBLIC_URL || "https://far-maps.vercel.app").replace(/\/$/, "");

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
    <>
      <meta name="fc:miniapp" content={content} />
      <meta name="fc:frame" content={content} />

      {/* Optional but helpful for many preview scrapers */}
      <meta property="og:title" content="Far Maps" />
      <meta
        property="og:description"
        content="Map your Farcaster followers + following by city"
      />
      <meta property="og:image" content={`${baseUrl}/embed.png`} />
    </>
  );
}

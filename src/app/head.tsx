export default function Head() {
  const baseUrl = process.env.NEXT_PUBLIC_URL ?? "https://far-maps.vercel.app";

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
      {/* backward compatibility */}
      <meta name="fc:frame" content={content} />
    </>
  );
}

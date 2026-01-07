export function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function neynarGet<T>(path: string): Promise<T> {
  const apiKey = mustEnv("NEYNAR_API_KEY");

  const res = await fetch(`https://api.neynar.com/v2/farcaster${path}`, {
    headers: {
      accept: "application/json",
      api_key: apiKey
    },
    // avoids caching weirdness in dev
    cache: "no-store"
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Neynar error ${res.status}: ${text}`);
  }

  return (await res.json()) as T;
}

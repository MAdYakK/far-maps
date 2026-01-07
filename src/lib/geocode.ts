import { LRUCache } from "lru-cache";

type Geo = { lat: number; lon: number; display_name?: string };

const cache = new LRUCache<string, Geo>({
  max: 2000,
  ttl: 1000 * 60 * 60 * 24 * 14 // 14 days
});

export async function geocodeCity(city: string): Promise<Geo | null> {
  const key = city.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: city,
      format: "json",
      limit: "1"
    }).toString();

  const res = await fetch(url, {
    headers: {
      // Nominatim asks for an identifying UA
      "User-Agent": "FarMaps/1.0 (demo; contact: none)"
    }
  });

  if (!res.ok) return null;

  const json = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const first = json[0];
  if (!first) return null;

  const geo = { lat: Number(first.lat), lon: Number(first.lon), display_name: first.display_name };
  if (!Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) return null;

  cache.set(key, geo);
  return geo;
}

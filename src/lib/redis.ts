// src/lib/redis.ts
import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

declare global {
  // eslint-disable-next-line no-var
  var __farmapsRedis: RedisClient | undefined;
  var __farmapsRedisConnecting: Promise<RedisClient> | undefined;
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Creates/returns a singleton Redis client (safe-ish for serverless)
export async function getRedis(): Promise<RedisClient> {
  // If we already have a connected client, return it.
  if (global.__farmapsRedis) return global.__farmapsRedis;

  // If a connect is already in-flight, await it (prevents stampede).
  if (global.__farmapsRedisConnecting) return global.__farmapsRedisConnecting;

  const url = mustEnv("REDIS_URL");

  const client = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => Math.min(1000 * 2 ** retries, 8000),
    },
  });

  client.on("error", (err) => {
    console.error("[redis] error:", err?.message || err);
  });

  global.__farmapsRedisConnecting = (async () => {
    await client.connect();
    global.__farmapsRedis = client;
    global.__farmapsRedisConnecting = undefined;
    return client;
  })();

  return global.__farmapsRedisConnecting;
}

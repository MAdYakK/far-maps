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
  // Already connected
  if (global.__farmapsRedis) return global.__farmapsRedis;

  // Connect in-flight
  if (global.__farmapsRedisConnecting) return global.__farmapsRedisConnecting;

  const url = mustEnv("REDIS_URL");

  const client = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => {
        // stop retrying after a while
        if (retries > 10) return new Error("Redis reconnect retries exhausted");
        return Math.min(250 * 2 ** retries, 8000);
      },
    },
  });

  client.on("error", (err) => {
    console.error("[redis] error:", err?.message || err);
  });

  global.__farmapsRedisConnecting = (async () => {
    try {
      await client.connect();

      // Optional: sanity check connection
      await client.ping();

      global.__farmapsRedis = client;
      return client;
    } finally {
      // Always clear in-flight marker (even if connect fails)
      global.__farmapsRedisConnecting = undefined;
    }
  })();

  return global.__farmapsRedisConnecting;
}

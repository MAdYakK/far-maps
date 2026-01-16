import "dotenv/config"; // loads .env by default
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Irys from "@irys/sdk";

// ✅ Explicitly load Next.js-style env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const amount = process.argv[2] || "0.0002"; // amount in ETH units to fund Irys

const irys = new Irys({
  url: process.env.IRYS_NODE_URL || "https://node1.irys.xyz",
  token: mustEnv("IRYS_TOKEN"), // "ethereum"
  key: mustEnv("IRYS_PRIVATE_KEY"),
  providerUrl: process.env.IRYS_RPC_URL, // ✅ Base RPC
});

async function main() {
  const addr = await irys.address;
  console.log("Irys address:", addr);

  const before = await irys.getLoadedBalance();
  console.log("Loaded balance before:", irys.utils.fromAtomic(before).toString());

  const atomic = irys.utils.toAtomic(amount);
  console.log("Funding amount:", amount, "(atomic:", atomic.toString(), ")");

  const receipt = await irys.fund(atomic);
  console.log("Fund receipt:", receipt);

  const after = await irys.getLoadedBalance();
  console.log("Loaded balance after:", irys.utils.fromAtomic(after).toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

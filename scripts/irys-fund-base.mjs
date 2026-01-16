import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Uploader } from "@irys/upload";
import { BaseEth } from "@irys/upload-ethereum";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const amountEth = process.argv[2] || "0.0002";
const pk = mustEnv("IRYS_PRIVATE_KEY");

const irys = await Uploader(BaseEth).withWallet(pk);

console.log("Uploader address:", irys.address);

const before = await irys.getLoadedBalance();
console.log("Loaded balance before:", irys.utils.fromAtomic(before).toString());

const atomic = irys.utils.toAtomic(Number(amountEth));
console.log("Funding:", amountEth, "ETH");

const receipt = await irys.fund(atomic);
console.log("Fund receipt:", receipt);

const after = await irys.getLoadedBalance();
console.log("Loaded balance after:", irys.utils.fromAtomic(after).toString());

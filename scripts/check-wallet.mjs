import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

// ✅ Load Next.js env file: ../.env.local
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const pk = process.env.IRYS_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!pk) throw new Error("Missing IRYS_PRIVATE_KEY (or PRIVATE_KEY) in .env.local");

const wallet = new ethers.Wallet(pk);

console.log("Wallet address:", wallet.address);

// Check MAINNET balance (because your current Irys fund call is hitting cloudflare-eth)
const mainnet = new ethers.JsonRpcProvider(
  `https://rpc.ankr.com/eth/${process.env.ANKR_API_KEY}`
);
const bal = await mainnet.getBalance(wallet.address);
console.log("Mainnet ETH:", ethers.formatEther(bal));

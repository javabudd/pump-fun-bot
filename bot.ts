import { connect, NatsConnection, StringCodec, Subscription } from "nats.ws";
import { WebSocket } from "ws";
import CoinMonitor from "./lib/coin-monitor";
import { Connection, Keypair } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { logger } from "./logger";
import { PumpFunSDK } from "pumpdotfun-sdk";

process.loadEnvFile(".env");

// @ts-expect-error it's global
(globalThis as unknown).WebSocket = WebSocket;

const getKeypair = (): Keypair => {
  const key = process.env.SOL_PRIVATE_KEY ?? "";
  const privateKeyArray = Uint8Array.from(key.split(",").map(Number));

  return Keypair.fromSecretKey(privateKeyArray);
};

const getProvider = () => {
  let walletUrl: string = "https://api.mainnet-beta.solana.com";
  let websocketUrl = "wss://api.mainnet-beta.solana.com";

  if (process.env.WALLET_RPC_URL) {
    walletUrl = process.env.WALLET_RPC_URL;
  }

  if (process.env.WALLET_WEBSOCKET_URL) {
    websocketUrl = process.env.WALLET_WEBSOCKET_URL;
  }

  let connection, keypair;

  try {
    connection = new Connection(walletUrl, {
      commitment: "confirmed",
      wsEndpoint: websocketUrl,
    });

    keypair = getKeypair();
  } catch (err) {
    logger.error("Error loading Solana wallet:", err);

    return;
  }

  const wallet = new Wallet(keypair);

  return new AnchorProvider(connection, wallet, { commitment: "finalized" });
};

(async function main(): Promise<void> {
  const provider = getProvider();

  if (provider === undefined || provider === null) {
    throw new Error("Failed to load Solana wallet");
  }

  const pumpFunSdk = new PumpFunSDK(provider);
  const url: string = "wss://prod-v2.nats.realtime.pump.fun/";
  const sc = StringCodec();

  const monitor = new CoinMonitor(
    pumpFunSdk,
    getKeypair(),
    1,
    process.env["AS_MOCK"]?.toLowerCase() === "true",
  );

  try {
    const nc: NatsConnection = await connect({
      servers: url,
      timeout: 1000,
      pedantic: false,
      user: "subscriber",
      pass: "lW5a9y20NceF6AE9",
    });

    logger.info("Connected to NATS WebSocket server");

    const sub: Subscription = nc.subscribe("newCoinCreated.prod");

    logger.info("Subscribed to newCoinCreated.prod");

    for await (const msg of sub) {
      const coin = JSON.parse(sc.decode(msg.data));

      monitor.startCoinMonitor(coin);
    }

    await nc.closed();
  } catch (err) {
    logger.error("Error connecting to NATS WebSocket:", err);
  }
})();

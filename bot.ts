import { connect, NatsConnection, StringCodec, Subscription } from "nats.ws";
import { WebSocket } from "ws";
import CoinMonitor from "./lib/coin-monitor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@project-serum/anchor";
import idl from "./idl.json";
import { PumpFun } from "./types/pump-fun";

process.loadEnvFile(".env");

// @ts-expect-error it's global
(globalThis as unknown).WebSocket = WebSocket;

type GlobalAccount = {
  feeRecipient: PublicKey;
  authority: PublicKey;
};

(async function main(): Promise<void> {
  const url: string = "wss://prod-v2.nats.realtime.pump.fun/";

  let walletUrl: string = "https://api.mainnet-beta.solana.com";
  let websocketUrl = "wss://api.mainnet-beta.solana.com";

  if (process.env.WALLET_RPC_URL) {
    walletUrl = process.env.WALLET_RPC_URL;
  }

  if (process.env.WALLET_WEBSOCKET_URL) {
    websocketUrl = process.env.WALLET_WEBSOCKET_URL;
  }

  const bondingCurveId = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const sc = StringCodec();

  let connection, keypair;

  try {
    connection = new Connection(walletUrl, {
      commitment: "confirmed",
      wsEndpoint: websocketUrl,
    });

    const key = process.env.SOL_PRIVATE_KEY ?? "";
    const privateKeyArray = Uint8Array.from(key.split(",").map(Number));

    keypair = Keypair.fromSecretKey(privateKeyArray);
  } catch (err) {
    console.error("Error loading Solana wallet:", err);

    return;
  }

  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // @ts-expect-error ignore idl spec for now
  const anchorProgram = new Program(idl, bondingCurveId, provider);

  const [globalPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("global")],
    anchorProgram.programId,
  );

  const globalAccount = (await anchorProgram.account.global.fetch(
    globalPDA,
  )) as unknown as GlobalAccount;

  if (!globalAccount) {
    console.error("No global account found!");

    return;
  }

  const pumpFun: PumpFun = {
    global: {
      feeRecipient: globalAccount.feeRecipient,
      pda: globalPDA,
      eventAuthority: globalAccount.authority,
    },
    connection,
    keypair,
    anchorProgram,
  };

  const monitor = new CoinMonitor(pumpFun, 1);

  try {
    const nc: NatsConnection = await connect({
      servers: url,
      timeout: 1000,
      pedantic: false,
      user: "subscriber",
      pass: "lW5a9y20NceF6AE9",
    });

    console.log("Connected to NATS WebSocket server");

    const sub: Subscription = nc.subscribe("newCoinCreated.prod");

    console.log("Subscribed to newCoinCreated.prod");

    for await (const msg of sub) {
      const coin = JSON.parse(sc.decode(msg.data));

      monitor.startCoinMonitor(coin);
    }

    await nc.closed();
  } catch (err) {
    console.error("Error connecting to NATS WebSocket:", err);
  }
})();

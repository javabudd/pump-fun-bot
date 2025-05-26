import { io } from "socket.io-client";
import CoinTrader from "./coin-trader";
import { Coin } from "../types/coin";
import { Trade } from "../types/trade";
import { logger } from "../logger";
import { PumpFunSDK } from "pumpdotfun-sdk";
import { Keypair } from "@solana/web3.js";
import { NotificationClient } from "./notifications";

export type SocialOptions = {
  twitter: string | null;
  telegram: string | null;
  website: string | null;
};

export type ScannerOptions = {
  marketCap: number;
  solAmount: number;
  socialConditionals: (socialOptions: SocialOptions) => boolean;
};

export default class CoinMonitor {
  private readonly pumpFunSocketIoUrl = "https://frontend-api-v3.pump.fun";

  private monitoredCoins: Record<string, Coin> = {};

  public constructor(
    private readonly pumpFun?: PumpFunSDK,
    private readonly buyerSellerKeypair?: Keypair,
    private readonly maximumMonitoredCoins = 1,
    private readonly asMock = false,
    private readonly notificationClient?: NotificationClient,
  ) {
    this.pumpFun = pumpFun;
    this.maximumMonitoredCoins = maximumMonitoredCoins;
    this.asMock = asMock;
  }

  public startScanner(scannerOptions: ScannerOptions): void {
    const socket = io(this.pumpFunSocketIoUrl, {
      path: "/socket.io/",
      transports: ["websocket"],
    });

    socket.on(`tradeCreated`, async (data) => {
      const trade: Trade = data;
      const solAmount = trade.sol_amount / 1000000000;

      if (
        trade.usd_market_cap >= scannerOptions.marketCap &&
        trade.is_buy &&
        solAmount >= scannerOptions.solAmount &&
        trade.user !== trade.creator &&
        scannerOptions.socialConditionals({
          twitter: trade.twitter,
          telegram: trade.telegram,
          website: trade.website,
        })
      ) {
        const url = `https://pump.fun/coin/${trade.mint}`;
        logger.info(`Big trade found: ${trade.name} - ${url}`);

        this.notificationClient?.send(trade);
      }
    });
  }

  public startCoinMonitor(newToken: Coin): void {
    if (this.monitoredCoins[newToken.mint]) {
      return;
    }

    if (Object.keys(this.monitoredCoins).length >= this.maximumMonitoredCoins) {
      return;
    }

    logger.info(`Monitoring coin ${newToken.name}`);

    newToken.monitorStart = new Date().toUTCString();
    this.monitoredCoins[newToken.mint] = newToken;

    this.subscribeToCoinTrades(newToken);
  }

  private subscribeToCoinTrades(coin: Coin): void {
    if (this.pumpFun === undefined) {
      throw new Error("Cannot subscribe to coin trades without a pump.fun SDK");
    }

    if (this.buyerSellerKeypair === undefined) {
      throw new Error(
        "Cannot subscribe to coin trades without a buyer/seller keypair",
      );
    }

    let trader: CoinTrader | null = new CoinTrader(
      this.pumpFun,
      this.buyerSellerKeypair,
      coin,
      this.asMock,
    );

    const socket = io(this.pumpFunSocketIoUrl, {
      path: "/socket.io/",
      transports: ["websocket"],
    });

    socket.on(`tradeCreated:${coin.mint}`, async (data) => {
      if (!trader) {
        return;
      }

      const trade: Trade = data;

      trader.addTrade(trade);
    });

    socket.on("connect", async () => {
      if (!trader) {
        return;
      }

      socket.emit("joinTradeRoom", { mint: coin.mint });

      const started = await trader.startSniper();

      if (!started) {
        socket.disconnect();
        return;
      }

      const attemptSellLoop = async () => {
        if (!trader) return;

        const tradeResult = await trader.attemptSniperSell();

        if (tradeResult === true) {
          socket.disconnect();
          return;
        }

        setTimeout(attemptSellLoop, 1000);
      };

      attemptSellLoop();
    });

    socket.on("disconnect", async () => {
      if (trader) {
        trader
          .closeAccount()
          .then((accountId) => {
            if (accountId) {
              logger.info(`Closed account for ${accountId}`);
            }
          })
          .catch((e) => {
            logger.error(`Error closing account: ${e}`);
          });
      }

      delete this.monitoredCoins[coin.mint];
      trader = null;
    });

    socket.on("connect_error", (err) => {
      logger.error("Socket connection error:", err);
      delete this.monitoredCoins[coin.mint];
      trader = null;
    });
  }
}

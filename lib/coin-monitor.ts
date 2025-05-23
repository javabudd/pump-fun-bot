import { io } from "socket.io-client";
import CoinTrader from "./coin-trader";
import { Coin } from "../types/coin";
import { Trade } from "../types/trade";
import { PumpFun } from "../types/pump-fun";
import { logger } from "../logger";

export default class CoinMonitor {
  private readonly pumpFunSocketIoUrl = "https://frontend-api-v3.pump.fun";

  private monitoredCoins: Record<string, Coin> = {};

  public constructor(
    private readonly pumpFun: PumpFun,
    private readonly maximumMonitoredCoins = 1,
    private readonly asMock = false,
  ) {
    this.pumpFun = pumpFun;
    this.maximumMonitoredCoins = maximumMonitoredCoins;
    this.asMock = asMock;
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

  public subscribeToCoinTrades(coin: Coin): void {
    let trader: CoinTrader | null = new CoinTrader(
      this.pumpFun,
      coin,
      this.asMock,
    );

    const socket = io(this.pumpFunSocketIoUrl, {
      path: "/socket.io/",
      transports: ["websocket"],
    });

    socket.on("connect", async () => {
      if (!trader) {
        return;
      }

      socket.emit("joinTradeRoom", { mint: coin.mint });

      const started = await trader.startSniper();

      if (!started) {
        socket.disconnect();
      }

      setTimeout(async () => {
        try {
          await trader?.doSell();
        } catch (error) {
          logger.error("Error while attempting to sell after timeout:", error);
        }
        socket.disconnect();
      }, 60000);

      socket.on(`tradeCreated:${coin.mint}`, async (data) => {
        if (!trader) {
          return;
        }

        const trade: Trade = data;
        const tradeResult = await trader.addTrade(trade);

        if (!trader || tradeResult !== undefined) {
          socket.disconnect();
        }
      });
    });

    socket.on("disconnect", async () => {
      if (trader) {
        trader.closeAccount().then((accountId) => {
          if (accountId) {
            logger.info(`Closed account for ${accountId}`);
          }
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

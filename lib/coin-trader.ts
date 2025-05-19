import { Coin } from "../types/coin";
import { Trade } from "../types/trade";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import {
  BondingCurveAccount,
  DEFAULT_DECIMALS,
  PumpFunSDK,
} from "pumpdotfun-sdk";
import { logger } from "../logger";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export default class CoinTrader {
  private trades: Array<Trade> = [];
  private isPlacingSale = false;
  private hasPosition = false;
  private buyPrice: number | null = null;
  private buyTimestamp?: number; // Track when we bought
  private highestPriceSinceBuy: number | null = null;
  private trailingStopMode = false; // Once take profit threshold is hit, we activate trailing stop mode

  private readonly stopLossRatio = 0.95; // If price < 95% of buy price, sell (5% drop)
  private readonly takeProfitRatio = 1.1; // If price > 110% of buy price, take profit (10% gain)
  private readonly trailingStopPercent = 0.05; // 5% drop from the peak triggers trailing stop sell
  private readonly positionAmount = 0.01;
  private readonly buySlippageBasisPoints = 1000n;
  private readonly sellSlippageBasisPoints = 2500n;
  private readonly maxPositionTime = 60; // max seconds to hold position
  private readonly blacklistedNameStrings = ["test"];
  private readonly computeUnits = 200_000;
  private readonly computeUnitPrice = 150_000;

  public constructor(
    private readonly pumpFun: PumpFunSDK,
    private readonly buyerSellerKeypair: Keypair,
    private readonly coin: Coin,
    private readonly asMock: boolean = false,
  ) {
    this.pumpFun = pumpFun;
    this.coin = coin;
    this.asMock = asMock;
  }

  public async startSniper(): Promise<boolean> {
    if (
      !this.coin.is_banned &&
      !this.coin.hidden &&
      !this.isNameBlacklisted(this.coin.name) &&
      (!!this.coin.twitter || !!this.coin.telegram || !!this.coin.website)
    ) {
      return this.buyTokens();
    } else {
      return false;
    }
  }

  public async closeAccount(): Promise<string> {
    return this.coin.mint;
    // return closeAccount(
    //   this.pumpFun.connection,
    //   this.buyerSellerKeypair,
    //   new PublicKey(this.coin.mint),
    //   this.buyerSellerKeypair.publicKey,
    //   this.buyerSellerKeypair,
    // );
  }

  public addTrade(trade: Trade): void {
    if (trade.mint !== this.coin.mint) {
      return;
    }

    this.trades.push(trade);

    if (trade.raydium_pool !== null) {
      logger.info(`Raydium reached for ${this.coin.name}!`);
    }
  }

  public async attemptSniperSell(): Promise<boolean | undefined> {
    if (
      !this.hasPosition ||
      this.isPlacingSale ||
      !this.buyTimestamp ||
      !this.buyPrice
    ) {
      return;
    }

    if (Date.now() - this.buyTimestamp >= this.maxPositionTime * 1000) {
      logger.warn("Position held to its maximum time, selling...");

      return this.doSell();
    }

    const trade = this.getLastTrade();

    if (!trade) {
      return;
    }

    const currentPrice =
      (trade.sol_amount + trade.virtual_sol_reserves) /
      ((trade.token_amount + trade.virtual_token_reserves) /
        Math.pow(10, DEFAULT_DECIMALS));

    if (!currentPrice) {
      logger.warn("No current price available, skipping stop-loss check.");
      return;
    }

    if (this.highestPriceSinceBuy && currentPrice > this.highestPriceSinceBuy) {
      this.highestPriceSinceBuy = currentPrice;
    }

    const stopLossThreshold = Math.abs(this.buyPrice * this.stopLossRatio);
    const takeProfitThreshold = Math.abs(this.buyPrice * this.takeProfitRatio);

    const isPumpEnding = this.checkPumpEndingSignal();
    const whalesSelling = this.detectWhaleSellOff(trade);

    let shouldSell = false;

    logger.info(`current: ${currentPrice}, stop: ${stopLossThreshold}`);

    if (currentPrice < stopLossThreshold) {
      shouldSell = true;
      logger.info(
        `Stop-loss triggered. Current: ${currentPrice}, Threshold: ${stopLossThreshold}`,
      );
    } else if (!this.trailingStopMode && currentPrice >= takeProfitThreshold) {
      // Hit initial take profit threshold
      // Instead of selling immediately, let's enter trailing stop mode
      this.trailingStopMode = true;
      this.highestPriceSinceBuy = currentPrice; // Reset the highest price in trailing mode
      logger.info(
        `Take-profit threshold reached. Entering trailing stop mode at price: ${currentPrice}`,
      );
    } else if (this.trailingStopMode && this.highestPriceSinceBuy) {
      // In trailing stop mode, if price falls by a certain percent from the highest peak, sell
      const trailingStopTrigger =
        this.highestPriceSinceBuy * (1 - this.trailingStopPercent);
      if (currentPrice < trailingStopTrigger) {
        shouldSell = true;
        logger.info(
          `Trailing stop triggered. Current: ${currentPrice}, Trigger: ${trailingStopTrigger}, Peak: ${this.highestPriceSinceBuy}`,
        );
      }
    }

    // Even if not triggered by stop-loss or trailing stop,
    // if external signals (pump ending or whales selling) appear, consider selling.
    if (!shouldSell && (isPumpEnding || whalesSelling)) {
      shouldSell = true;
      logger.info(
        "Pump-ending or whale-selling signal detected, exiting position.",
      );
    }

    if (!shouldSell) {
      return;
    }

    return this.doSell();
  }

  public async doSell() {
    this.isPlacingSale = true;

    let sold;
    try {
      sold = await this.sellTokens();
    } catch (error) {
      logger.error(`Error while attempting to sell: ${error}`);

      this.isPlacingSale = false;

      return false;
    }

    if (sold) {
      logger.info("Position closed successfully.");
    } else {
      logger.info("Sell attempt failed.");
    }
    this.isPlacingSale = false;
    this.hasPosition = false;
    this.highestPriceSinceBuy = null;
    this.trailingStopMode = false;
    this.buyTimestamp = undefined;
    this.buyPrice = null;

    return sold;
  }

  private async buyTokens(): Promise<boolean> {
    const url = `https://pump.fun/coin/${this.coin.mint}`;
    const isMockString = this.asMock ? " mock " : " ";
    logger.attemptBuy(
      `Executing${isMockString}buy for ${this.coin.name} at ${url}...`,
    );

    if (this.asMock) {
      this.setBuyProperties();

      return true;
    }

    const mintPublicKey = new PublicKey(this.coin.mint);

    await this.waitForBondingCurve(mintPublicKey);

    let buyResults;
    try {
      buyResults = await this.pumpFun.buy(
        this.buyerSellerKeypair,
        mintPublicKey,
        BigInt(this.positionAmount * LAMPORTS_PER_SOL),
        this.buySlippageBasisPoints,
        {
          unitLimit: this.computeUnits,
          unitPrice: this.computeUnitPrice,
        },
        "processed",
        "confirmed",
      );
    } catch (error) {
      logger.error(`Error while attempting to buy: ${error}`);

      return false;
    }

    if (buyResults.success) {
      logger.buy(
        `Buy transaction successful: ${buyResults.results?.blockTime}`,
      );

      this.setBuyProperties();

      return true;
    } else {
      logger.error(`Buy failed: ${buyResults.error}`);

      return false;
    }
  }

  private async sellTokens(): Promise<boolean> {
    if (this.asMock) {
      logger.attemptSell("Executing mock sell...");

      return true;
    }

    const mintPublicKey = new PublicKey(this.coin.mint);

    await this.waitForBondingCurve(mintPublicKey);

    const currentSPLBalance = await this.getSPLBalance(mintPublicKey);
    if (currentSPLBalance === null) {
      logger.error("Balance empty...");

      return false;
    }

    logger.info(`Selling ${currentSPLBalance} ${this.coin.name}`);

    const sellResults = await this.pumpFun.sell(
      this.buyerSellerKeypair,
      mintPublicKey,
      BigInt(currentSPLBalance),
      this.sellSlippageBasisPoints,
      {
        unitLimit: this.computeUnits,
        unitPrice: this.computeUnitPrice,
      },
      "confirmed",
      "confirmed",
    );

    if (sellResults.success) {
      logger.sell(
        `Sell transaction successful: ${sellResults.results?.blockTime}`,
      );

      return true;
    } else {
      logger.error(`Sell failed: ${sellResults.error}`);

      return false;
    }
  }

  private checkPumpEndingSignal(): boolean {
    // Return true if external conditions indicate the pump is ending
    return false;
  }

  private detectWhaleSellOff(trade: Trade): boolean {
    if (trade.user === "some known whale" && !trade.is_buy) {
      return true;
    }

    return false;
  }

  private isNameBlacklisted(name: string): boolean {
    return this.blacklistedNameStrings.some((blacklist) =>
      name.toLowerCase().includes(blacklist.toLowerCase()),
    );
  }

  private setBuyProperties(): void {
    let virtualSolReserves = this.coin.virtual_sol_reserves;
    let virtualTokenReserves = this.coin.virtual_token_reserves;
    const lastTrade = this.getLastTrade();
    if (lastTrade) {
      virtualSolReserves = lastTrade.virtual_sol_reserves;
      virtualTokenReserves = lastTrade.virtual_token_reserves;
    }

    const estimatedSolReserves =
      virtualSolReserves + Math.abs(this.positionAmount);
    const tokenOutflow =
      this.positionAmount * (virtualTokenReserves / virtualSolReserves);
    const estimatedTokenReserves =
      virtualTokenReserves - Math.abs(tokenOutflow);

    this.buyPrice =
      estimatedSolReserves /
      (estimatedTokenReserves / Math.pow(10, DEFAULT_DECIMALS));

    this.hasPosition = true;
    this.buyTimestamp = Date.now();
    this.highestPriceSinceBuy = this.buyPrice;
  }

  private async waitForBondingCurve(
    mint: PublicKey,
    maxRetries = 7,
    baseDelayMs = 500,
  ): Promise<BondingCurveAccount> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const bondingCurve = await this.pumpFun.getBondingCurveAccount(
          mint,
          "confirmed",
        );
        if (bondingCurve) return bondingCurve;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        logger.info(`Bonding curve not ready yet... (retry ${i + 1})`);
      }

      const delay = baseDelayMs * Math.pow(2, i);
      logger.info(`Waiting ${delay}ms before next attempt...`);
      await new Promise((res) => setTimeout(res, delay));
    }

    throw new Error("Bonding curve account not found after retries");
  }

  private async getSPLBalance(
    mintAddress: PublicKey,
    allowOffCurve: boolean = false,
  ): Promise<number | null> {
    try {
      const ata = getAssociatedTokenAddressSync(
        mintAddress,
        this.buyerSellerKeypair.publicKey,
        allowOffCurve,
      );
      const balance = await this.pumpFun.connection.getTokenAccountBalance(
        ata,
        "processed",
      );
      return parseInt(balance.value.amount);
    } catch (e) {
      logger.error(`Failed retrieving balance ${e}`);
    }
    return null;
  }

  private getLastTrade(): Trade | undefined {
    return this.trades[this.trades.length - 1];
  }
}

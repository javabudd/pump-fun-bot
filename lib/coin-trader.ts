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
  private associatedUserAddress: PublicKey | null = null;
  private buyPrice: number | null = null;
  private buyTimestamp?: number; // Track when we bought
  private highestPriceSinceBuy: number | null = null;
  private trailingStopMode = false; // Once take profit threshold is hit, we activate trailing stop mode

  private readonly MAX_UINT32 = 4294967295;
  private readonly stopLossRatio = 0.95; // If price < 95% of buy price, sell (5% drop)
  private readonly takeProfitRatio = 1.1; // If price > 110% of buy price, take profit (10% gain)
  private readonly trailingStopPercent = 0.05; // 5% drop from the peak triggers trailing stop sell
  private readonly positionAmount = 0.02;
  private readonly slippageBasisPoints = 300n;

  private readonly blacklistedNameStrings = ["test"];
  private readonly decimals = 9;

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
      (this.coin.twitter || this.coin.telegram)
    ) {
      return this.buyTokens();
    } else {
      return false;
    }
  }

  public async closeAccount(): Promise<string | undefined> {
    if (!this.associatedUserAddress) {
      return;
    }

    const account = await this.pumpFun.getBondingCurveAccount(
      new PublicKey(this.coin.mint),
    );

    logger.info(`Bonding account to close: ${account}`);

    // @TODO close account
  }

  public async addTrade(trade: Trade): Promise<boolean | undefined> {
    if (trade.mint !== this.coin.mint) {
      return;
    }

    this.trades.push(trade);

    if (trade.raydium_pool !== null) {
      logger.info(`Raydium reached for ${this.coin.name}!`);

      return;
    }

    return this.attemptSniperSell(trade);
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
        this.slippageBasisPoints,
        {
          unitLimit: this.estimateUnitLimitForBuy(this.positionAmount),
          unitPrice: this.estimateUnitPrice(),
        },
        "confirmed",
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
      BigInt(currentSPLBalance * Math.pow(10, DEFAULT_DECIMALS)),
      this.slippageBasisPoints,
      {
        unitLimit: this.estimateUnitLimitForSell(currentSPLBalance),
        unitPrice: this.estimateUnitPrice(),
      },
      "finalized",
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

  private async attemptSniperSell(trade: Trade): Promise<boolean | undefined> {
    if (
      !this.hasPosition ||
      this.isPlacingSale ||
      !this.buyTimestamp ||
      !this.buyPrice ||
      trade.user === this.pumpFun.program.provider.publicKey?.toBase58()
    ) {
      return;
    }

    const currentPrice =
      (trade.sol_amount + trade.virtual_sol_reserves) /
      ((trade.token_amount + trade.virtual_token_reserves) /
        Math.pow(10, this.decimals));

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
    const estimatedSolReserves =
      this.coin.virtual_sol_reserves + Math.abs(this.positionAmount);
    const tokenOutflow =
      this.positionAmount *
      (this.coin.virtual_token_reserves / this.coin.virtual_sol_reserves);
    const estimatedTokenReserves =
      this.coin.virtual_token_reserves - Math.abs(tokenOutflow);

    this.buyPrice =
      estimatedSolReserves /
      (estimatedTokenReserves / Math.pow(10, this.decimals));

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
      return balance.value.uiAmount;
    } catch (e) {
      logger.error(`Failed retrieving balance ${e}`);
    }
    return null;
  }

  private estimateUnitPrice(): number {
    const { virtual_token_reserves, virtual_sol_reserves } = this.coin;
    // 1) Marginal price in lamports per token:
    //    reserves are lamports and raw token units
    const pricePerToken =
      virtual_sol_reserves /
      (virtual_token_reserves / Math.pow(10, this.decimals));

    // 2) Apply buffer for slippage (e.g. +5%)
    const bufferedPrice = pricePerToken * 1.05;

    // 3) Round up to an integer, clamp to u32 max
    const unitPrice = Math.min(this.MAX_UINT32, Math.ceil(bufferedPrice));

    return unitPrice;
  }

  private estimateUnitLimitForBuy(solAmount: number): number {
    // 1) How many lamports we’re spending
    const lamportsToSpend = solAmount * LAMPORTS_PER_SOL;

    // 2) Get the same base price per token (without buffer)
    const basePrice =
      this.coin.virtual_sol_reserves /
      (this.coin.virtual_token_reserves / Math.pow(10, this.decimals));

    // 3) Use the *buffered* price so we don’t under-estimate
    const priceWithBuffer = basePrice * 1.05;

    // 4) Tokens you expect to receive (as a float, in “whole” tokens)
    const expectedTokens = lamportsToSpend / priceWithBuffer;

    // 5) Scale to the token’s atomic units (decimals)
    let units = Math.floor(expectedTokens * Math.pow(10, this.decimals));

    // 6) Add a small extra buffer (e.g. 10%) so rounding/trades don’t fail
    units = Math.floor(units * 1.1);

    // 7) Clamp to u32 max
    units = Math.min(units, this.MAX_UINT32);

    return units;
  }

  private estimateUnitLimitForSell(uiAmount: number): number {
    let units = Math.floor(uiAmount * Math.pow(10, this.decimals)); // scale to raw units

    units = Math.floor(units * 0.99); // 1% buffer down to avoid rounding issues

    units = Math.min(units, this.MAX_UINT32);

    return units;
  }
}

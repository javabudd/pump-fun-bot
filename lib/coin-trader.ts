import { Coin } from "../types/coin";
import { Trade } from "../types/trade";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BN } from "@project-serum/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  closeAccount,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PumpFun } from "../types/pump-fun";
import { Buffer } from "buffer";
import { logger } from "../logger";

export default class CoinTrader {
  private trades: Array<Trade> = [];
  private isPlacingSale = false;
  private hasPosition = false;
  private associatedUserAddress: PublicKey | null = null;
  private buyPrice: number | null = null;
  private buyTimestamp?: number; // Track when we bought
  private highestPriceSinceBuy: number | null = null;
  private trailingStopMode = false; // Once take profit threshold is hit, we activate trailing stop mode

  private readonly stopLossRatio = 0.95; // If price < 95% of buy price, sell (5% drop)
  private readonly takeProfitRatio = 1.1; // If price > 110% of buy price, take profit (10% gain)
  private readonly trailingStopPercent = 0.05; // 5% drop from the peak triggers trailing stop sell
  private readonly computeUnits = 200_000;
  private readonly priorityFee = 150000;
  private readonly positionAmount = 500 * 1_000_000_000;
  private readonly pumpFunAuthority =
    "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1";

  private readonly blacklistedNameStrings = ["test"];
  private readonly decimals = 9;

  public constructor(
    private readonly pumpFun: PumpFun,
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
      return this.buy();
    } else {
      return false;
    }
  }

  public async closeAccount(): Promise<string | undefined> {
    if (!this.associatedUserAddress) {
      return;
    }

    try {
      await closeAccount(
        this.pumpFun.connection,
        this.pumpFun.keypair,
        this.associatedUserAddress,
        this.pumpFun.keypair.publicKey,
        this.pumpFun.keypair,
        [],
        {
          maxRetries: 10,
          skipPreflight: true,
          commitment: "confirmed",
        },
      );
    } catch {
      logger.error(
        `Failed to close associated token account: ${this.associatedUserAddress?.toBase58()}`,
      );
      return;
    }

    return this.associatedUserAddress?.toBase58();
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
    try {
      this.isPlacingSale = true;
      const sold = await this.sell();
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
    } catch (error) {
      logger.error("Error while attempting to sell:", error);
      return false;
    }
  }

  private async buy(): Promise<boolean> {
    const url = `https://pump.fun/coin/${this.coin.mint}`;
    const isMockString = this.asMock ? " mock " : " ";
    logger.attemptBuy(
      `Executing${isMockString}buy for ${this.coin.name} at ${url}...`,
    );

    if (this.asMock) {
      this.setBuyProperties();

      return true;
    }

    const mint = new PublicKey(this.coin.mint);
    this.associatedUserAddress = getAssociatedTokenAddressSync(
      mint,
      this.pumpFun.keypair.publicKey,
      false,
    );

    logger.info("Creating associated token account...");

    const latestBlockhash =
      await this.pumpFun.connection.getLatestBlockhash("confirmed");
    const feeInstructions = [
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.priorityFee,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({
        units: this.computeUnits,
      }),
    ];

    const message = new TransactionMessage({
      payerKey: this.pumpFun.keypair.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...feeInstructions,
        createAssociatedTokenAccountInstruction(
          this.pumpFun.keypair.publicKey,
          this.associatedUserAddress!,
          this.pumpFun.keypair.publicKey,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      ],
    }).compileToV0Message();

    const versionedTransaction = new VersionedTransaction(message);
    versionedTransaction.sign([this.pumpFun.keypair]);

    try {
      await this.pumpFun.connection.sendRawTransaction(
        versionedTransaction.serialize(),
        {
          maxRetries: 1,
          skipPreflight: false,
        },
      );
    } catch {
      logger.error("Associated token account creation failed!");
      return false;
    }

    logger.info(
      `Associated token account created: ${this.associatedUserAddress.toBase58()}`,
    );

    try {
      const tx = await this.pumpFun.anchorProgram.methods
        .buy(
          new BN(this.positionAmount),
          new BN(this.positionAmount).muln(105).divn(100),
        )
        .preInstructions(feeInstructions)
        .accounts({
          global: this.pumpFun.global.pda,
          user: this.pumpFun.keypair.publicKey,
          mint,
          feeRecipient: this.pumpFun.global.feeRecipient,
          bondingCurve: new PublicKey(this.coin.bonding_curve),
          associatedBondingCurve: new PublicKey(
            this.coin.associated_bonding_curve,
          ),
          associatedUser: this.associatedUserAddress,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: new PublicKey(this.pumpFunAuthority),
          program: this.pumpFun.anchorProgram.programId,
        })
        .signers([this.pumpFun.keypair])
        .rpc({ maxRetries: 10, commitment: "processed", skipPreflight: false });

      logger.buy(`Buy transaction successful: ${tx}`);

      this.setBuyProperties();

      return true;
    } catch (e: unknown) {
      logger.error(`Buy failed: ${e}`);

      return false;
    }
  }

  private async sell(slippageTolerance: number = 0.1): Promise<boolean> {
    if (this.asMock) {
      logger.attemptSell("Executing mock sell...");

      return true;
    }

    const mint = new PublicKey(this.coin.mint);

    if (!this.associatedUserAddress) {
      this.associatedUserAddress = getAssociatedTokenAddressSync(
        mint,
        this.pumpFun.keypair.publicKey,
        false,
      );
    }

    let expectedSolOutput;
    try {
      expectedSolOutput = await this.getExpectedSolOutput(this.positionAmount);
    } catch {
      return false;
    }

    const slippageMultiplier = new BN(10000 - slippageTolerance * 10000).div(
      new BN(10000),
    );
    const minSolOutput = expectedSolOutput.mul(slippageMultiplier);

    logger.attemptSell(
      `Executing sell for "${this.coin.name}" with slippage ${slippageTolerance} and min output ${minSolOutput}...`,
    );

    try {
      const transaction = await this.pumpFun.anchorProgram.methods
        .sell(new BN(this.positionAmount), new BN(minSolOutput))
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: this.priorityFee,
          }),
          ComputeBudgetProgram.setComputeUnitLimit({
            units: this.computeUnits,
          }),
        ])
        .accounts({
          global: this.pumpFun.global.pda,
          user: this.pumpFun.keypair.publicKey,
          mint,
          feeRecipient: this.pumpFun.global.feeRecipient,
          bondingCurve: new PublicKey(this.coin.bonding_curve),
          associatedBondingCurve: new PublicKey(
            this.coin.associated_bonding_curve,
          ),
          associatedUser: this.associatedUserAddress,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: new PublicKey(this.pumpFunAuthority),
          program: this.pumpFun.anchorProgram.programId,
        })
        .signers([this.pumpFun.keypair])
        .rpc({
          maxRetries: 3,
          commitment: "confirmed",
          skipPreflight: true,
        });

      logger.sell(`Sell transaction successful: ${transaction}`);
      return true;
    } catch (err) {
      logger.error("Sell transaction failed!", err);
      return false;
    }
  }

  private async attemptSniperSell(trade: Trade): Promise<boolean | undefined> {
    if (
      !this.hasPosition ||
      this.isPlacingSale ||
      !this.buyTimestamp ||
      !this.buyPrice ||
      trade.user === this.pumpFun.keypair.publicKey.toBase58()
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

  private async getExpectedSolOutput(amount: number): Promise<BN> {
    const bondingCurveAddress = new PublicKey(this.coin.bonding_curve);
    const bondingCurveInfo =
      await this.pumpFun.connection.getAccountInfo(bondingCurveAddress);

    if (!bondingCurveInfo) {
      throw Error("Could not retrieve bonding curve!");
    }

    const bondingCurveData = this.parseBondingCurve(bondingCurveInfo.data);

    const { virtualTokenReserves, virtualSolReserves, feeBasisPoints } =
      bondingCurveData;

    const amountBN = new BN(amount);
    const feeMultiplier = new BN(10000).sub(feeBasisPoints).div(new BN(10000));

    return amountBN
      .mul(virtualSolReserves)
      .div(virtualTokenReserves.add(amountBN))
      .mul(feeMultiplier);
  }

  private parseBondingCurve(data: Buffer): {
    virtualTokenReserves: BN;
    virtualSolReserves: BN;
    feeBasisPoints: BN;
  } {
    const virtualTokenReserves = new BN(data.slice(0, 8), "le"); // u64
    const virtualSolReserves = new BN(data.slice(8, 16), "le"); // u64
    const feeBasisPoints = new BN(data.slice(16, 20), "le"); // u32

    return { virtualTokenReserves, virtualSolReserves, feeBasisPoints };
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
}

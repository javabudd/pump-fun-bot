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

export default class CoinTrader {
  private trades: Array<Trade> = [];
  private isPlacingSale = false;
  private hasPosition = false;
  private associatedUserAddress: PublicKey | null = null;
  private buyPrice: number | null = null;

  private readonly sleepAfterSell = 2000;
  private readonly computeUnits = 200_000; // default is 140,000
  private readonly priorityFee = 900000; // 0.0009 SOL as priority fee
  private readonly positionAmount = 500 * 1_000_000_000; // 500k tokens
  private readonly startingMarketCap = 7000;
  private readonly pumpFunAuthority =
    "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1";

  public constructor(
    private readonly pumpFun: PumpFun,
    private readonly coin: Coin,
  ) {
    this.pumpFun = pumpFun;
    this.coin = coin;
  }

  public async startSniper(): Promise<boolean> {
    if (
      this.coin.usd_market_cap <= this.startingMarketCap &&
      this.coin.twitter &&
      this.coin.telegram
    ) {
      console.log(
        `Initiating sniper for ${this.coin.name} (${this.coin.mint})...`,
      );

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
      console.error(
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

    return this.attemptSniperSell(trade);
  }

  public async doSell() {
    try {
      this.isPlacingSale = true;
      if (await this.sell()) {
        await this.sleep();
      }
      this.isPlacingSale = false;
    } catch (error) {
      console.error("Error while attempting to sell:", error);

      return false;
    }

    return true;
  }

  private async buy(): Promise<boolean> {
    const url = `https://pump.fun/coin/${this.coin.mint}`;

    console.log(`Executing buy for ${this.coin.name} at ${url}...`);

    const mint = new PublicKey(this.coin.mint);

    this.associatedUserAddress = getAssociatedTokenAddressSync(
      mint,
      this.pumpFun.keypair.publicKey,
      false,
    );

    console.log("Creating associated token account...");

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
          skipPreflight: true,
        },
      );
    } catch {
      console.error("Associated token account creation failed!");
      return false;
    }

    console.log(
      "Associated token account created:",
      this.associatedUserAddress.toBase58(),
    );

    try {
      console.log("Executing buy transaction...");

      const transaction = await this.pumpFun.anchorProgram.methods
        .buy(
          new BN(this.positionAmount),
          new BN(this.positionAmount + this.positionAmount * 0.05), // Max SOL cost with 5% slippage
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
        .rpc({
          maxRetries: 10,
          commitment: "processed",
          skipPreflight: true,
        });

      console.log(`Buy transaction successful: ${transaction}`);

      this.hasPosition = true;
      this.buyPrice =
        this.coin.virtual_sol_reserves / this.coin.virtual_token_reserves;

      return true;
    } catch (error) {
      console.error("Buy transaction failed: ", error);

      return false;
    }
  }

  private async sell(slippageTolerance: number = 0.1): Promise<boolean> {
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

    // Calculate minSolOutput using BN arithmetic
    const slippageMultiplier = new BN(10000 - slippageTolerance * 10000).div(
      new BN(10000),
    );

    const minSolOutput = expectedSolOutput.mul(slippageMultiplier);

    console.log(
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

      console.log(`Sell transaction successful: ${transaction}`);
    } catch {
      console.error("Sell transaction failed!");

      return false;
    }

    return true;
  }

  private async attemptSniperSell(trade: Trade): Promise<boolean | undefined> {
    if (!this.hasPosition || this.isPlacingSale) {
      return;
    }

    let priceChange = 0,
      dynamicVolumeThreshold = 0,
      dynamicPriceChangeThreshold = 0,
      shortTermTrend = 0,
      longTermTrendThreshold = 0;

    let shouldSell: boolean,
      volumeMetric = false,
      priceChangeMetric = false,
      momentumMetric = false,
      stopLossMetric = false;

    const currentPrice =
      (trade.virtual_sol_reserves + trade.sol_amount) /
      (trade.virtual_token_reserves + trade.token_amount);

    // Stop-loss threshold: 10% drop
    const stopLossThreshold = this.buyPrice! * 0.9;
    if (currentPrice < stopLossThreshold) {
      shouldSell = true;
      stopLossMetric = shouldSell;
    } else {
      // Step 1: Calculate Dynamic Volume Threshold (Retained)
      const recentTrades = this.trades.slice(-50);
      const avgVolume =
        recentTrades.reduce((sum, t) => sum + t.token_amount, 0) /
        (recentTrades.length || 1);
      const marketCapVolatilityFactor =
        trade.usd_market_cap < 50_000
          ? 5
          : trade.usd_market_cap < 100_000
            ? 2.5
            : 1;

      dynamicVolumeThreshold = avgVolume * marketCapVolatilityFactor;

      volumeMetric = trade.token_amount > dynamicVolumeThreshold;

      // Step 2: Enhanced Price Change Detection
      const volatility = this.calculateVolatility(
        recentTrades.map((t) => t.sol_amount),
      );

      dynamicPriceChangeThreshold = 0.01 + volatility * 0.02; // Base + volatility adjustment

      const solPriceBefore =
        trade.virtual_sol_reserves / trade.virtual_token_reserves;
      const solPriceAfter =
        (trade.virtual_sol_reserves + trade.sol_amount) /
        (trade.virtual_token_reserves + trade.token_amount);

      priceChange = Math.abs((solPriceAfter - solPriceBefore) / solPriceBefore);

      priceChangeMetric = priceChange > dynamicPriceChangeThreshold;

      // Step 3: Assess Momentum
      shortTermTrend = this.calculateEMA(
        this.trades.slice(-10).map((t) => t.sol_amount),
        5,
      );

      const longTermTrend = this.calculateEMA(
        this.trades.map((t) => t.sol_amount),
        20,
      );

      longTermTrendThreshold = longTermTrend * 2; // Significant upward trend

      momentumMetric = shortTermTrend > longTermTrendThreshold;

      // Step 4: Combine Metrics
      shouldSell = volumeMetric || priceChangeMetric || momentumMetric;
    }

    if (!shouldSell) {
      return;
    }

    const scale = 1000000000;
    const logVolume = trade.token_amount / scale;
    const logDynamicVolumeThreshold = dynamicVolumeThreshold / scale;

    console.log({
      triggeredMetrics: {
        volumeMetric,
        priceChangeMetric,
        momentumMetric,
        stopLossMetric,
      },
      thresholds: [
        { volume: logVolume, threshold: logDynamicVolumeThreshold },
        { priceChange, threshold: dynamicPriceChangeThreshold },
        { shortTermTrend, threshold: longTermTrendThreshold },
      ],
    });

    return this.doSell();
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.sleepAfterSell));
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

  private calculateEMA(data: number[], period: number): number {
    const k = 2 / (period + 1);
    return data.reduce(
      (prev, curr, idx) => (idx === 0 ? curr : curr * k + prev * (1 - k)),
      0,
    );
  }

  private isSustainedPriceChange(): boolean {
    const lookback = 20; // Last 20 trades
    const recentPrices = this.trades.slice(-lookback).map((t) => t.sol_amount);

    const recoveryThreshold = 0.95; // 95% recovery
    const initialDrop = Math.min(...recentPrices) / recentPrices[0];
    const recovery =
      recentPrices[recentPrices.length - 1] / Math.min(...recentPrices);

    return initialDrop < recoveryThreshold && recovery > recoveryThreshold;
  }

  private calculateVolatility(data: number[]): number {
    if (data.length === 0) {
      return 0; // No volatility for empty data
    }

    // Step 1: Calculate the mean
    const mean = data.reduce((sum, value) => sum + value, 0) / data.length;

    // Step 2: Calculate the squared differences from the mean
    const squaredDiffs = data.map((value) => Math.pow(value - mean, 2));

    // Step 3: Calculate the variance (mean of squared differences)
    const variance =
      squaredDiffs.reduce((sum, value) => sum + value, 0) / data.length;

    // Step 4: Return the standard deviation (square root of variance)
    return Math.sqrt(variance);
  }
}

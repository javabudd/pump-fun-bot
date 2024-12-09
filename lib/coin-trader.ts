import { Coin } from "../types/coin";
import { Trade } from "../types/trade";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
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
  public shouldTerminate = false;

  private trades: Array<Trade> = [];
  private isPlacingSale = false;
  private hasPosition = false;
  private associatedUserAddress: PublicKey | null = null;
  private tradeStartTime?: Date;

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
    console.log(
      `Initiating sniper for ${this.coin.name} (${this.coin.mint})...`,
    );

    if (this.coin.usd_market_cap <= this.startingMarketCap) {
      return this.buy();
    } else {
      return false;
    }
  }

  public async addTrade(trade: Trade): Promise<void> {
    this.trades.push(trade);

    await this.attemptSniperSell(trade);
  }

  private async buy(): Promise<boolean> {
    const url = `https://pump.fun/coin/${this.coin.mint}`;

    console.log(`Executing buy for ${this.coin.name} at ${url}...`);

    const mint = new PublicKey(this.coin.mint);

    const associatedUserAddress = getAssociatedTokenAddressSync(
      mint,
      this.pumpFun.keypair.publicKey,
      false,
    );

    const ataInfo = await this.pumpFun.connection.getAccountInfo(
      associatedUserAddress,
    );
    if (!ataInfo) {
      console.log("Creating associated token account...");

      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          this.pumpFun.keypair.publicKey,
          associatedUserAddress,
          this.pumpFun.keypair.publicKey,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );

      try {
        await this.pumpFun.connection.sendTransaction(transaction, [
          this.pumpFun.keypair,
        ]);
      } catch {
        console.error("Associated token account creation failed!");
        return false;
      }

      await this.sleep(100);

      console.log(
        "Associated token account created:",
        associatedUserAddress.toBase58(),
      );
    } else {
      console.log(
        "Associated token account already exists:",
        associatedUserAddress.toBase58(),
      );
    }

    try {
      await this.pumpFun.anchorProgram.account.global.fetch(
        this.pumpFun.global.pda,
      );
    } catch {
      console.log("Initializing global account...");

      await this.pumpFun.anchorProgram.methods
        .initialize()
        .accounts({
          global: this.pumpFun.global.pda,
          user: this.pumpFun.keypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.pumpFun.keypair])
        .rpc();

      console.log("Global account initialized.");
    }

    await this.ensureAtaInitialized(associatedUserAddress);

    try {
      console.log("Executing buy transaction...");

      const transaction = await this.pumpFun.anchorProgram.methods
        .buy(
          new BN(this.positionAmount),
          new BN(this.positionAmount + this.positionAmount * 0.05), // Max SOL cost with 5% slippage
        )
        .accounts({
          global: this.pumpFun.global.pda,
          user: this.pumpFun.keypair.publicKey,
          mint,
          feeRecipient: this.pumpFun.global.feeRecipient,
          bondingCurve: new PublicKey(this.coin.bonding_curve),
          associatedBondingCurve: new PublicKey(
            this.coin.associated_bonding_curve,
          ),
          associatedUser: associatedUserAddress,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: new PublicKey(this.pumpFunAuthority),
          program: this.pumpFun.anchorProgram.programId,
        })
        .signers([this.pumpFun.keypair])
        .rpc({
          maxRetries: 5,
          commitment: "confirmed",
          skipPreflight: true,
        });

      console.log(`Buy transaction successful: ${transaction}`);

      this.tradeStartTime = new Date();
      this.hasPosition = true;

      return true;
    } catch {
      console.error("Buy transaction failed!");

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
          maxRetries: 5,
          commitment: "confirmed",
          skipPreflight: true,
        });

      console.log(`Sell transaction successful: ${transaction}`);
    } catch {
      console.error("Sell transaction failed!");

      return false;
    }

    this.shouldTerminate = true;

    return true;
  }

  private async attemptSniperSell(trade: Trade): Promise<void> {
    if (!this.hasPosition || this.isPlacingSale) {
      return;
    }

    const solPriceBefore =
      trade.virtual_sol_reserves / trade.virtual_token_reserves;
    const solPriceAfter =
      (trade.virtual_sol_reserves + trade.sol_amount) /
      (trade.virtual_token_reserves + trade.token_amount);

    const volumeThreshold = 100_000_000_000_000;
    const momentumThreshold = 5;
    const priceImpactThreshold = 0.02;

    const volumeMetric = trade.token_amount > volumeThreshold;
    const momentumMetric = this.calculateMomentum() > momentumThreshold;
    const priceChangeMetric =
      Math.abs((solPriceAfter - solPriceBefore) / solPriceBefore) >
      priceImpactThreshold;

    if (volumeMetric || momentumMetric || priceChangeMetric) {
      console.log({ volumeMetric, momentumMetric, priceChangeMetric });

      try {
        this.isPlacingSale = true;
        if (await this.sell()) {
          await this.cleanupAfterSale();
          await this.sleep(3000);
        }
        this.isPlacingSale = false;
      } catch (error) {
        console.error("Error while attempting to sell:", error);
      }

      return;
    }

    if (
      this.tradeStartTime &&
      new Date() >= new Date(this.tradeStartTime.getTime() + 30 * 1000)
    ) {
      try {
        console.log("30 seconds elapsed. Selling as a fallback...");
        this.isPlacingSale = true;
        await this.sell();
        this.isPlacingSale = false;
      } catch (error) {
        console.error("Error while attempting to sell after timeout:", error);
      }
    }
  }

  private calculateMomentum(): number {
    const tradeCount = this.trades.length;
    const lookback = Math.min(50, Math.max(10, Math.floor(tradeCount / 5)));
    const prices = this.trades.slice(-lookback).map((t) => t.usd_market_cap);

    return (prices[prices.length - 1] - prices[0]) / prices[0];
  }

  private async ensureAtaInitialized(
    associatedUserAddress: PublicKey,
    maxAttempts = 10,
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ataInfo = await this.pumpFun.connection.getAccountInfo(
        associatedUserAddress,
      );
      if (ataInfo) {
        return;
      }

      await this.sleep(1000);
    }
    throw new Error("ATA initialization failed after retries.");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  private async cleanupAfterSale(): Promise<void> {
    if (!this.associatedUserAddress) {
      console.warn("No associated user address found for cleanup.");
      return;
    }

    console.log(
      `Closing associated token account: ${this.associatedUserAddress.toBase58()}...`,
    );

    try {
      const transactionSignature = await closeAccount(
        this.pumpFun.connection,
        this.pumpFun.keypair,
        this.associatedUserAddress,
        this.pumpFun.keypair.publicKey,
        this.pumpFun.keypair,
      );

      console.log(
        `Successfully closed associated token account: ${this.associatedUserAddress.toBase58()}`,
        `Transaction signature: ${transactionSignature}`,
      );

      // Reset associated user address to null after cleanup
      this.associatedUserAddress = null;
    } catch (error) {
      console.error(
        `Failed to close associated token account: ${this.associatedUserAddress?.toBase58()}`,
        error,
      );
    }
  }
}

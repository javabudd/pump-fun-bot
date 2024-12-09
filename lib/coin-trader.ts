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
  public shouldTerminate = false;

  private trades: Array<Trade> = [];
  private isPlacingSale = false;
  private hasPosition = false;
  private associatedUserAddress: PublicKey | null = null;
  private tradeStartTime?: Date;

  private readonly computeUnits = 400_000;
  private readonly priorityFee = 50000; // 0.000005 SOL as priority fee
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

  public closeAccount(): void {
    if (!this.associatedUserAddress) {
      console.warn("No associated user address found for cleanup.");
      return;
    }

    try {
      closeAccount(
        this.pumpFun.connection,
        this.pumpFun.keypair,
        this.associatedUserAddress,
        this.pumpFun.keypair.publicKey,
        this.pumpFun.keypair,
        [],
        {
          maxRetries: 5,
          skipPreflight: true,
          commitment: "finalized",
        },
      ).then(() => {
        console.log(
          `Successfully closed associated token account: ${this.associatedUserAddress?.toBase58()}`,
        );
      });
    } catch {
      console.error(
        `Failed to close associated token account: ${this.associatedUserAddress?.toBase58()}`,
      );
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
      await this.ensureAtaInitialized(12);
    } catch (error) {
      console.error(error);

      return false;
    }

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

      this.shouldTerminate = true;

      return false;
    }

    this.shouldTerminate = true;

    return true;
  }

  private async attemptSniperSell(trade: Trade): Promise<void> {
    if (!this.hasPosition || this.isPlacingSale) {
      return;
    }

    const sleepAfterSell = 2000;
    const timeoutSeconds = 45;

    const solPriceBefore =
      trade.virtual_sol_reserves / trade.virtual_token_reserves;
    const solPriceAfter =
      (trade.virtual_sol_reserves + trade.sol_amount) /
      (trade.virtual_token_reserves + trade.token_amount);

    const volumeThreshold = 100_000_000_000_000;
    const momentumThreshold = 7;
    const priceImpactThreshold = 0.009;

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
          await this.sleep(sleepAfterSell);
        }
        this.isPlacingSale = false;
      } catch (error) {
        console.error("Error while attempting to sell:", error);
      }

      return;
    }

    if (
      this.tradeStartTime &&
      new Date() >=
        new Date(this.tradeStartTime.getTime() + timeoutSeconds * 1000)
    ) {
      try {
        console.log(
          `${timeoutSeconds} seconds elapsed. Selling as a fallback...`,
        );
        this.isPlacingSale = true;
        if (await this.sell()) {
          await this.sleep(sleepAfterSell);
        }
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

  private async ensureAtaInitialized(maxAttempts = 5): Promise<void> {
    if (!this.associatedUserAddress) {
      throw new Error(
        "ATA initialization does not have required associated user address.",
      );
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ataInfo = await this.pumpFun.connection.getAccountInfo(
        this.associatedUserAddress,
        {
          commitment: "processed",
        },
      );

      if (ataInfo) {
        return;
      }

      await this.sleep(500);
    }
    throw new Error(`ATA initialization failed after ${maxAttempts} retries.`);
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
}

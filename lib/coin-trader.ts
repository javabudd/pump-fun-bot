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
  private buyTimestamp?: number; // Track when we bought for time-based logic

  // Simple configuration parameters for a more pump-event-oriented strategy
  private readonly stopLossPercent = 0.95; // 5% drop triggers stop-loss
  private readonly takeProfitPercent = 1.5; // 50% gain triggers take-profit
  private readonly computeUnits = 200_000; // default is 140,000
  private readonly priorityFee = 300000; // 0.003 SOL as priority fee
  private readonly positionAmount = 750 * 1_000_000_000; // 750k tokens
  private readonly startingMarketCapMin = 10000;
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
      this.coin.usd_market_cap >= this.startingMarketCapMin &&
      this.coin.twitter &&
      this.coin.telegram
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
      await this.sell();
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
      this.buyTimestamp = Date.now(); // Record the time we entered the position

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
    if (!this.hasPosition || this.isPlacingSale || !this.buyTimestamp) {
      return;
    }

    const currentPrice =
      (trade.virtual_sol_reserves + trade.sol_amount) /
      (trade.virtual_token_reserves + trade.token_amount);

    const stopLossThreshold = this.buyPrice! * this.stopLossPercent;
    const takeProfitThreshold = this.buyPrice! * this.takeProfitPercent;

    // Check external signals (stub methods to be implemented)
    const isPumpEnding = this.checkPumpEndingSignal();
    const whalesSelling = this.detectWhaleSellOff(trade);

    let shouldSell = false;

    if (currentPrice < stopLossThreshold) {
      shouldSell = true;
      console.log(
        `Stop-loss triggered. Current: ${currentPrice}, Threshold: ${stopLossThreshold}`,
      );
    } else if (currentPrice > takeProfitThreshold) {
      shouldSell = true;
      console.log(
        `Take-profit triggered. Current: ${currentPrice}, Threshold: ${takeProfitThreshold}`,
      );
    } else if (isPumpEnding || whalesSelling) {
      shouldSell = true;
      console.log(
        "Pump-ending or whale-selling signal detected, exiting position.",
      );
    }

    if (!shouldSell) {
      return;
    }

    return this.doSell();
  }

  // Implement logic here (e.g., check external APIs, timer-based logic, etc.)
  private checkPumpEndingSignal(): boolean {
    // For now, always return false. Implement as needed.
    return false;
  }

  // Implement logic here, e.g., track known wallets and see if they are selling
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
}

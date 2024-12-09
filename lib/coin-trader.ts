import { Coin } from "../types/coin";
import { Trade } from "../types/trade";
import {
  AccountInfo,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { BN } from "@project-serum/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PumpFun } from "../types/pump-fun";
import { Buffer } from "buffer";

export default class CoinTrader {
  public shouldTerminate = false;

  private trades: Array<Trade> = [];
  private timeoutHandle?: NodeJS.Timeout;
  private isPlacingSale = false;
  private hasPosition = false;
  private bondingCurveInfo: AccountInfo<Buffer> | null = null;
  private associatedUserAddress: PublicKey | null = null;

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

  public async startSniper(): Promise<void> {
    console.log(
      `Initiating sniper for ${this.coin.name} (${this.coin.mint})...`,
    );

    if (this.coin.usd_market_cap <= this.startingMarketCap) {
      await this.buy();
    } else {
      this.disconnect();
      return;
    }

    // Sell and disconnect after 2 minutes if no trades are made
    this.timeoutHandle = setTimeout(
      () => {
        console.log(
          "No trades made within 2 minutes, selling and disconnecting...",
        );
        this.sell();
        this.disconnect();
      },
      2 * 60 * 1000,
    ); // 2 minutes in milliseconds
  }

  public stopSniper(): void {
    console.log("Sniper stopped");
    this.disconnect();
  }

  public async addTrade(trade: Trade): Promise<void> {
    this.trades.push(trade);

    await this.attemptSniperSell(trade);
  }

  private async buy(): Promise<void> {
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

      await this.pumpFun.connection.sendTransaction(transaction, [
        this.pumpFun.keypair,
      ]);

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
          skipPreflight: true,
        });

      console.log(`Buy transaction successful: ${transaction}`);

      this.hasPosition = true;
    } catch {
      console.error("Buy transaction failed!");
    }
  }

  private async sell(slippageTolerance: number = 0.1): Promise<void> {
    this.isPlacingSale = true;

    const mint = new PublicKey(this.coin.mint);

    if (!this.associatedUserAddress) {
      this.associatedUserAddress = getAssociatedTokenAddressSync(
        mint,
        this.pumpFun.keypair.publicKey,
        false,
      );
    }

    const expectedSolOutput = await this.getExpectedSolOutput(
      this.positionAmount,
    );

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

      await this.sleep(5000);
    } catch {
      console.error("Sell transaction failed!");
    }

    this.shouldTerminate = true;
    this.isPlacingSale = false;
  }

  private disconnect(): void {
    console.log(`Disconnecting ${this.coin.name}...`);

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
    }
  }

  private async attemptSniperSell(trade: Trade): Promise<void> {
    if (!this.hasPosition || this.isPlacingSale) {
      return;
    }

    const currentVolume = trade.token_amount;
    const momentum = this.calculateMomentum();

    const volumeThreshold = 60000000000000;
    const momentumThreshold = 4;

    if (currentVolume > volumeThreshold || momentum > momentumThreshold) {
      await this.sell();
    }
  }

  private calculateMomentum(): number {
    const prices = this.trades.slice(-20).map((t) => t.usd_market_cap);
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

      console.log(`Retrying ATA creation (${attempt + 1}/${maxAttempts})...`);
      await this.sleep(1000);
    }
    throw new Error("ATA initialization failed after retries.");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async getExpectedSolOutput(amount: number): Promise<BN> {
    if (!this.bondingCurveInfo) {
      const bondingCurveAddress = new PublicKey(this.coin.bonding_curve);

      const bondingCurveInfo =
        await this.pumpFun.connection.getAccountInfo(bondingCurveAddress);

      if (!bondingCurveInfo) {
        throw Error("Could not retrieve bonding curve!");
      }

      this.bondingCurveInfo = bondingCurveInfo;
    }

    const bondingCurveData = this.parseBondingCurve(this.bondingCurveInfo.data);

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

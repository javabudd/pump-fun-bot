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
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PumpFun } from "../types/pump-fun";

export default class CoinTrader {
  public shouldTerminate = false;

  private trades: Array<Trade> = [];
  private hasPosition = false;
  private timeoutHandle?: NodeJS.Timeout;
  private isPlacingSale = false;

  private readonly positionAmount = 500 * 1_000_000_000; // 1 million
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
        this.retrySell();
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
    console.log(`Executing buy for ${this.coin.name}...`);

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
      const globalAccount =
        await this.pumpFun.anchorProgram.account.global.fetch(
          this.pumpFun.global.pda,
        );
      console.debug("Global account already initialized:", globalAccount);
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
        .rpc();

      console.log(`Buy transaction successful: ${transaction}`);
      this.hasPosition = true;
    } catch (error) {
      console.error("Buy transaction failed:", error);
    }
  }

  private async sell(slippageTolerance: number = 0.05): Promise<void> {
    if (this.isPlacingSale) {
      return;
    }

    this.isPlacingSale = true;

    console.log(
      `Executing sell for ${this.coin.name} with slippage ${slippageTolerance}...`,
    );

    const mint = new PublicKey(this.coin.mint);

    const associatedUserAddress = getAssociatedTokenAddressSync(
      mint,
      this.pumpFun.keypair.publicKey,
      false,
    );

    const expectedSolOutput = await this.getExpectedSolOutput(
      this.positionAmount,
    );

    // Calculate minSolOutput using BN arithmetic
    const slippageMultiplier = new BN(10000 - slippageTolerance * 10000).div(
      new BN(10000),
    );

    const minSolOutput = expectedSolOutput.mul(slippageMultiplier);

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
          associatedUser: associatedUserAddress,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: new PublicKey(this.pumpFunAuthority),
          program: this.pumpFun.anchorProgram.programId,
        })
        .signers([this.pumpFun.keypair])
        .rpc();

      console.log(transaction);
      console.log(`Sell transaction successful: ${transaction}`);

      this.hasPosition = false;
      this.shouldTerminate = true;
      this.isPlacingSale = false;
    } catch (error) {
      console.error("Sell transaction failed:", error);
      this.isPlacingSale = false;
    }
  }

  private async retrySell(): Promise<void> {
    const maxRetries = 5;
    const initialSlippage = 0.25;
    const slippageIncrement = 0.05;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const currentSlippage =
        initialSlippage + slippageIncrement * (attempt - 1);
      try {
        await this.sell(currentSlippage);
        return;
      } catch (error) {
        console.log(`Retrying sell (${attempt}/${maxRetries})...`, error);
        await this.sleep(5000);
      }
    }
    console.error("Failed to execute sell after retries.");
  }

  private disconnect(): void {
    console.log(`Disconnecting ${this.coin.name}...`);

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
    }
  }

  private async attemptSniperSell(trade: Trade): Promise<void> {
    if (!this.hasPosition) {
      return;
    }

    if (trade.usd_market_cap > 15000) {
      await this.sell();
    }
  }

  private async ensureAtaInitialized(
    associatedUserAddress: PublicKey,
    maxAttempts = 7,
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
    const bondingCurveAddress = new PublicKey(this.coin.bonding_curve);

    // Fetch bonding curve account data
    const bondingCurveInfo =
      await this.pumpFun.connection.getAccountInfo(bondingCurveAddress);

    if (!bondingCurveInfo) {
      throw new Error("Failed to fetch bonding curve information");
    }

    // Parse the bonding curve data
    const bondingCurveData = this.parseBondingCurve(bondingCurveInfo.data);

    const { virtualTokenReserves, virtualSolReserves, feeBasisPoints } =
      bondingCurveData;

    // Convert inputs to BN
    const amountBN = new BN(amount);

    // Fee multiplier as a BN (10000 - feeBasisPoints) / 10000
    const feeMultiplier = new BN(10000).sub(feeBasisPoints).div(new BN(10000));

    // Calculate expected SOL output using BN arithmetic
    const expectedSolOutput = amountBN
      .mul(virtualSolReserves)
      .div(virtualTokenReserves.add(amountBN))
      .mul(feeMultiplier);

    console.log(
      `Calculated expected SOL output: ${expectedSolOutput.toString()}, using virtualTokenReserves: ${virtualTokenReserves.toString()}, virtualSolReserves: ${virtualSolReserves.toString()}, feeMultiplier: ${feeMultiplier.toString()}`,
    );

    return expectedSolOutput;
  }

  private parseBondingCurve(data: Buffer): {
    virtualTokenReserves: BN;
    virtualSolReserves: BN;
    feeBasisPoints: BN;
  } {
    // Parse the bonding curve data and return BN values
    const virtualTokenReserves = new BN(data.slice(0, 8), "le"); // u64
    const virtualSolReserves = new BN(data.slice(8, 16), "le"); // u64
    const feeBasisPoints = new BN(data.slice(16, 20), "le"); // u32

    return { virtualTokenReserves, virtualSolReserves, feeBasisPoints };
  }
}

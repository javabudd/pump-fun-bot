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

  private readonly positionAmount = 0.005 * 1_000_000_000;
  private readonly startingMarketCap = 7000;

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

  public async buy(): Promise<void> {
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
      console.log("Global account already initialized:", globalAccount);
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

    const [expectedEventAuthority] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("event_authority_seed"),
        this.pumpFun.keypair.publicKey.toBuffer(),
      ],
      this.pumpFun.anchorProgram.programId,
    );

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
          eventAuthority: expectedEventAuthority,
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

  public async sell(): Promise<void> {
    console.log(`Executing sell for ${this.coin.name}...`);

    const mint = new PublicKey(this.coin.mint);

    const associatedUserAddress = getAssociatedTokenAddressSync(
      mint,
      this.pumpFun.keypair.publicKey,
      false,
    );

    const [expectedEventAuthority] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("event_authority_seed"),
        this.pumpFun.keypair.publicKey.toBuffer(),
      ],
      this.pumpFun.anchorProgram.programId,
    );

    try {
      const transaction = await this.pumpFun.anchorProgram.methods
        .sell(
          new BN(this.positionAmount),
          new BN(this.positionAmount + this.positionAmount * 0.05),
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
          eventAuthority: expectedEventAuthority,
          program: this.pumpFun.anchorProgram.programId,
        })
        .signers([this.pumpFun.keypair])
        .rpc();

      console.log(transaction);
      console.log(`Sell transaction successful: ${transaction}`);

      this.hasPosition = false;
      this.shouldTerminate = true;
    } catch (error) {
      console.error("Sell transaction failed:", error);
    }
  }

  public async addTrade(trade: Trade): Promise<void> {
    this.trades.push(trade);

    await this.attemptSniperSell(trade);
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

    if (trade.usd_market_cap > 10000) {
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
}

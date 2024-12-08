import {Coin} from "../types/coin";
import {Trade} from "../types/trade";
import {PublicKey, SystemProgram,} from '@solana/web3.js';
import {BN} from "@project-serum/anchor";
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {PumpFun} from "../types/pump-fun";

export default class CoinTrader {
	public shouldTerminate = false;

	private timeoutHandle: any;
	private trades: Array<Trade> = [];
	private hasPosition = false;

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
		console.log(`Initiating sniper for ${this.coin.name} (${this.coin.mint})...`);

		if (this.coin.usd_market_cap <= this.startingMarketCap) {
			await this.buy();
		} else {
			this.disconnect();
			return;
		}

		// Sell and disconnect after 2 minutes if no trades are made
		this.timeoutHandle = setTimeout(() => {
			console.log("No trades made within 2 minutes, selling and disconnecting...");
			this.sell();
			this.disconnect();
		}, 2 * 60 * 1000); // 2 minutes in milliseconds
	}

	public stopSniper(): void {
		console.log("Sniper stopped");
		this.disconnect();
	}

	public async buy(): Promise<void> {
		console.log(`Executing buy for ${this.coin.name}...`);

		const mint = new PublicKey(this.coin.mint);

		try {
			const transaction = await this.pumpFun.anchorProgram.methods.buy(
				new BN(this.positionAmount),
				new BN(this.positionAmount + (this.positionAmount * 0.05)),
			).accounts({
				global: this.pumpFun.global.pda,
				user: this.pumpFun.keypair.publicKey,
				mint,
				feeRecipient: this.pumpFun.global.feeRecipient,
				bondingCurve: new PublicKey(this.coin.bonding_curve),
				associatedBondingCurve: new PublicKey(this.coin.associated_bonding_curve),
				associatedUser: this.pumpFun.keypair.publicKey,
				systemProgram: SystemProgram.programId,
				tokenProgram: TOKEN_PROGRAM_ID,
				eventAuthority: this.pumpFun.global.eventAuthority,
				program: this.pumpFun.anchorProgram.programId,
			})
				.simulate();
			// .signers([this.pumpFun.keypair])
			// .rpc();

			console.log(transaction);
			console.log(`Buy transaction successful: ${transaction}`);
			this.hasPosition = true;
		} catch (error) {
			console.error('Buy transaction failed:', error);
		}
	}

	public async sell(): Promise<void> {
		console.log(`Executing sell for ${this.coin.name}...`);

		const mint = new PublicKey(this.coin.mint);

		try {
			const transaction = await this.pumpFun.anchorProgram.methods.sell(
				new BN(this.positionAmount),
				new BN(this.positionAmount + (this.positionAmount * 0.05)),
			)
				.accounts({
					global: this.pumpFun.global.pda,
					user: this.pumpFun.keypair.publicKey,
					mint,
					feeRecipient: this.pumpFun.global.feeRecipient,
					bondingCurve: new PublicKey(this.coin.bonding_curve),
					associatedBondingCurve: new PublicKey(this.coin.associated_bonding_curve),
					systemProgram: SystemProgram.programId,
					tokenProgram: TOKEN_PROGRAM_ID,
					eventAuthority: this.pumpFun.global.eventAuthority,
					program: this.pumpFun.anchorProgram.programId,
				})
				.simulate();
			// .signers([this.pumpFun.keypair])
			// .rpc();

			console.log(transaction);
			console.log(`Sell transaction successful: ${transaction}`);

			this.hasPosition = false;
			this.shouldTerminate = true;
		} catch (error) {
			console.error('Sell transaction failed:', error);
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
}

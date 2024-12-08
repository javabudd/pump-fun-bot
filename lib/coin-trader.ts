import {Coin} from "../types/coin";
import {Trade} from "../types/trade";
import {PublicKey, sendAndConfirmTransaction, Transaction, TransactionInstruction,} from '@solana/web3.js';
import {SolanaWallet} from "../types/solanaWallet";

export default class CoinTrader {
	public shouldTerminate = false;

	private timeoutHandle: any;
	private trades: Array<Trade> = [];
	private hasPosition = false;

	private readonly positionAmount = 0.005 * 1_000_000_000;
	private readonly startingMarketCap = 7000;

	public constructor(
		private readonly solanaWallet: SolanaWallet,
		private readonly coin: Coin,
		private readonly pumpApiKey: string,
		private readonly pumpPrivateKey: string
	) {
		this.solanaWallet = solanaWallet;
		this.coin = coin;
		this.pumpApiKey = pumpApiKey;
		this.pumpPrivateKey = pumpPrivateKey;
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

		const amountInLamports = this.positionAmount;
		const mint = new PublicKey(this.coin.mint);
		const signature = await this.tradeToken(mint, amountInLamports, true);
		this.hasPosition = true;

		console.log(`Buy transaction successful: ${signature}`);
	}

	public async sell(): Promise<void> {
		console.log(`Executing sell for ${this.coin.name}...`);

		const amountInLamports = this.positionAmount;
		const mint = new PublicKey(this.coin.mint);
		const signature = await this.tradeToken(mint, amountInLamports, false);
		this.hasPosition = false;
		this.shouldTerminate = true;

		console.log(`Sell transaction successful: ${signature}`);
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

	private async tradeToken(
		mint: PublicKey,
		amount: number,
		isBuy: boolean
	): Promise<string> {
		try {
			const transaction = new Transaction();
			const amountBytes = Array.from(BigInt(amount).toString().split('').map(Number));
			const instructionData = Buffer.from(
				Uint8Array.of(isBuy ? 1 : 0, ...amountBytes)
			);

			// @ts-ignore
			const instruction = new TransactionInstruction({
				keys: [
					{
						pubkey: this.solanaWallet.wallet.publicKey,
						isSigner: true,
						isWritable: true
					},
					{
						pubkey: mint,
						isSigner: false,
						isWritable: true
					}
				],
				programId: this.solanaWallet.bondingCurveProgram,
				data: instructionData,
			});

			transaction.add(instruction);

			return await sendAndConfirmTransaction(
				this.solanaWallet.connection,
				transaction, [this.solanaWallet.wallet]
			);
		} catch (error) {
			console.error('Error during trade:', error);
			throw error;
		}
	}
}

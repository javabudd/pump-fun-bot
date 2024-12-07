import axios from 'axios';

import {Coin, Trade} from "./coin-monitor";

export default class CoinTrader {
	public shouldTerminate = false;

	private mintSubscription: any;
	private timeoutHandle: any;
	private trades: Array<Trade> = [];
	private hasPosition = false;
	private readonly startingMarketCap = 7000;
	private apiUrl = 'https://pumpapi.fun/api/trade';

	constructor(
		private readonly coin: Coin,
		private readonly pumpApiKey: string,
		private readonly pumpPrivateKey: string
	) {
		this.coin = coin;
		this.pumpApiKey = pumpApiKey;
		this.pumpPrivateKey = pumpPrivateKey;
	}

	public startSniper() {
		console.log(`Initiating sniper for ${this.coin.name} (${this.coin.mint})...`);

		if (this.coin.usd_market_cap <= this.startingMarketCap) {
			this.buy();
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

	public stopSniper() {
		console.log("Sniper stopped");
		this.disconnect();
	}

	public async buy(): Promise<void> {
		console.log(`Executing buy for ${this.coin.name}...`);

		try {
			const response = await axios.post(
				this.apiUrl,
				{
					trade_type: 'buy',
					mint: this.coin.mint,
					amount: .05,
					slippage: 25,
					userPrivateKey: this.pumpPrivateKey,
				},
				{
					headers: {
						'Authorization': `Bearer ${this.pumpApiKey}`,
					},
				}
			);
			console.log('Buy response:', response.data);
			this.hasPosition = true;
		} catch (error) {
			console.error('Buy error:', error);
		}
	}

	public async sell(): Promise<void> {
		console.log(`Executing sell for ${this.coin.name}...`);

		try {
			const response = await axios.post(
				this.apiUrl,
				{
					trade_type: 'sell',
					mint: this.coin.mint,
					amount: .05,
					slippage: 25,
					userPrivateKey: this.pumpPrivateKey,
				},
				{
					headers: {
						'Authorization': `Bearer ${this.pumpApiKey}`,
					},
				}
			);
			console.log('Sell response:', response.data);
			this.hasPosition = false;
		} catch (error) {
			console.error('Sell error:', error);
		}
	}

	public addTrade(trade: Trade): void {
		this.trades.push(trade);
		this.attemptSniperSell(trade);
	}

	private disconnect(): void {
		console.log(`Disconnecting ${this.coin.name}...`);

		if (this.mintSubscription) {
			this.mintSubscription.unsubscribe();
		}
		if (this.timeoutHandle) {
			clearTimeout(this.timeoutHandle);
		}
	}

	private attemptSniperSell(trade: Trade): void {
		if (!this.hasPosition) {
			return;
		}

		if (trade.usd_market_cap > 10000) {
			console.log(`Selling ${this.coin.name}`);
			this.hasPosition = false;
			this.shouldTerminate = true;
		}
	}
}

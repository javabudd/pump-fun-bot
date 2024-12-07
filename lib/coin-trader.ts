import {Coin, Trade} from "./coin-monitor";

export default class CoinTrader {
	private mintSubscription: any;
	private timeoutHandle: any;
	private trades: Array<Trade> = [];
	private hasPosition = false;
	private readonly startingMarketCap = 7000;

	constructor(private readonly coin: Coin) {
		this.coin = coin;
	}

	public startSniper() {
		console.log(`Initiating sniper for ${this.coin.name} (${this.coin.mint})...`);

		if (this.coin.usd_market_cap <= this.startingMarketCap) {
			console.log(`Market cap is below limit, buying...`);
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

	public buy(): void {
		console.log("Executing buy...");
		this.hasPosition = true;
		// @TODO SOL buy logic
	}

	public sell(): void {
		console.log("Executing sell...");
		// @TODO SOL sell logic
	}

	public addTrade(trade: Trade): void {
		this.trades.push(trade);
		this.attemptSniperSell(trade);
	}

	private disconnect(): void {
		console.log("Disconnecting...");

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
			console.log('sell sell sell!!');
		}
	}
}

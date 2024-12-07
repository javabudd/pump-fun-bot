import {Coin, Trade} from "./coin-monitor";

export default class CoinTrader {
	private mintSubscription: any;
	private timeoutHandle: any;
	private trades: Array<Trade> = [];

	constructor(private readonly coin: Coin, private readonly priceLimit: number) {
		this.coin = coin;
		this.priceLimit = priceLimit;
	}

	public startSniper() {
		console.log(`Initiating sniper for ${this.coin.name} (${this.coin.mint})...`);

		// Example: Simulate checking the current price and buying if below the limit
		const currentPrice = this.getCurrentPrice();
		if (currentPrice <= this.priceLimit) {
			console.log(`Price (${currentPrice}) is below limit (${this.priceLimit}), buying...`);
			this.buy();
		} else {
			console.log(`Price (${currentPrice}) is above limit, not buying.`);
			this.disconnect();

			return;
		}

		// Set a timeout to sell and disconnect after 2 minutes if no trades are made
		this.timeoutHandle = setTimeout(() => {
			console.log("No trades made in 2 minutes, selling and disconnecting...");
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

		// @TODO SOL buy logic
	}

	public sell(): void {
		console.log("Executing sell...");

		// @TODO SOL sell logic
	}

	public addTrade(trade: Trade): void {
		this.trades.push(trade);
		this.attemptSniperTrade();
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

	private getCurrentPrice(): number {
		if (this.trades.length === 0) {
			return 0;
		}

		return this.trades[-1].sol_amount;
	}

	private attemptSniperTrade(): void {
		// logic here to determine if we should buy/sell depending on
		// no position
		// a position
		// a position with no trade activity
	}
}

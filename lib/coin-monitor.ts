import {io} from "socket.io-client";
import CoinTrader from "./coin-trader";

export type Trade = {
	signature: string;
	sol_amount: number;
	token_amount: number;
	is_buy: boolean;
	user: string;
	timestamp: number;
	mint: string;
	virtual_sol_reserves: number;
	virtual_token_reserves: number;
	slot: number;
	tx_index: number;
	name: string;
	symbol: string;
	description: string;
	image_uri: string | null;
	video_uri: string | null;
	metadata_uri: string;
	twitter: string | null;
	telegram: string | null;
	bonding_curve: string;
	associated_bonding_curve: string;
	creator: string;
	created_timestamp: number;
	raydium_pool: string | null;
	complete: boolean;
	total_supply: number;
	website: string | null;
	show_name: boolean;
	king_of_the_hill_timestamp: number | null;
	market_cap: number;
	reply_count: number;
	last_reply: number | null;
	nsfw: boolean;
	market_id: string | null;
	inverted: boolean | null;
	is_currently_live: boolean;
	username: string;
	profile_image: string;
	creator_username: string;
	creator_profile_image: string | null;
	usd_market_cap: number;
};

export type Coin = {
	// api fields
	mint: string;
	name: string;
	symbol: string;
	description: string;
	image_uri: string;
	metadata_uri: string;
	twitter: string | null;
	telegram: string | null;
	bonding_curve: string;
	associated_bonding_curve: string;
	creator: string;
	created_timestamp: number;
	raydium_pool: string;
	complete: boolean;
	virtual_sol_reserves: number;
	virtual_token_reserves: number;
	hidden: boolean | null;
	total_supply: number;
	website: string | null;
	show_name: boolean;
	last_trade_timestamp: number | null;
	king_of_the_hill_timestamp: number | null;
	market_cap: number;
	usd_market_cap: number;
	nsfw: boolean;
	market_id: string | null;
	inverted: boolean | null;

	// local
	monitorStart: string;
};

export default class CoinMonitor {
	private maximumMonitoredCoins = 5;
	private monitoredCoins: Record<string, Coin> = {};
	private trippedMonitoredCoins: Record<string, Trade> = {};

	public startCoinMonitor(newToken: Coin): void {
		if (this.monitoredCoins[newToken.mint]) {
			console.warn(`Coin ${newToken.name} is already being monitored.`);
			return;
		}

		if (Object.keys(this.monitoredCoins).length >= this.maximumMonitoredCoins) {
			// this.pruneMonitoredCoins();
			return;
		}

		console.info(`Monitoring coin ${newToken.name}`);

		newToken.monitorStart = new Date().toUTCString();
		this.monitoredCoins[newToken.mint] = newToken;

		this.subscribeToCoinTrades(newToken);

		// this.pruneMonitoredCoins();
	}

	public stopCoinMonitor(mint: string): void {
		if (!this.monitoredCoins[mint]) {
			console.warn(`Coin with mint ${mint} is not being monitored.`);
			return;
		}

		console.info(`Stopped monitoring coin with mint ${mint}`);
		delete this.monitoredCoins[mint];

		if (this.trippedMonitoredCoins[mint]) {
			delete this.trippedMonitoredCoins[mint];
		}
	}

	public pruneMonitoredCoins(): void {
		const monitoredMints = Object.keys(this.monitoredCoins);

		if (monitoredMints.length <= this.maximumMonitoredCoins) {
			return;
		}

		console.info("Pruning monitored coins...");

		const untrippedMints = monitoredMints.filter(
			(mint) => !(mint in this.trippedMonitoredCoins)
		);

		let sortedMints: string[] = untrippedMints.length > 0
			? untrippedMints.sort((a, b) =>
				new Date(this.monitoredCoins[a].monitorStart).getTime() -
				new Date(this.monitoredCoins[b].monitorStart).getTime()
			)
			: monitoredMints.sort((a, b) =>
				new Date(this.monitoredCoins[a].monitorStart).getTime() -
				new Date(this.monitoredCoins[b].monitorStart).getTime()
			);

		const coinsToRemove = sortedMints.slice(
			0,
			monitoredMints.length - this.maximumMonitoredCoins
		);

		for (const mint of coinsToRemove) {
			console.info(`Pruned coin with mint ${mint}`);
			delete this.monitoredCoins[mint];
		}
	}

	public subscribeToCoinTrades(coin: Coin): void {
		const trader = new CoinTrader(coin, 10);
		const socket = io("https://frontend-api.pump.fun", {
			path: "/socket.io/",
			transports: ["websocket"],
		});

		socket.on("connect", () => {
			socket.emit("joinTradeRoom", {mint: coin.mint});

			trader.startSniper();

			console.log(`Joined trade room for mint: ${coin.mint}`);
		});

		socket.on("tradeCreated", (data) => {
			const trade: Trade = data;
			this.handleTrade(trader, trade);
		});

		socket.on("disconnect", (reason) => {
			console.log(`Disconnected from trade room: ${reason}`);
			trader.stopSniper();
		});

		socket.on("connect_error", (err) => {
			console.error("Socket connection error:", err);
			trader.stopSniper();
		});
	}

	private handleTrade(trader: CoinTrader, trade: Trade): void {
		trader.addTrade(trade);

		if (trade.is_buy) {
			this.trippedMonitoredCoins[trade.mint] = trade;
		} else if (this.trippedMonitoredCoins[trade.mint]) {
			delete this.trippedMonitoredCoins[trade.mint];
		}
	}
}


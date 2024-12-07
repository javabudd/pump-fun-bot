import {io} from "socket.io-client";

enum TradeType {
	Buy,
	Sell
}

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
	private maximumMonitoredCoins = 75;
	private monitoredCoins: Record<string, Coin> = {};
	private trippedMonitoredCoins: Record<string, Trade> = {};

	public startCoinMonitor(newToken: Coin): void {
		if (this.monitoredCoins[newToken.mint]) {
			return;
		}

		if (Object.keys(this.monitoredCoins).length >= this.maximumMonitoredCoins) {
			return;
		}

		console.info(`Monitoring coin ${newToken.name}`);

		newToken.monitorStart = new Date().toUTCString();

		this.monitoredCoins[newToken.mint] = newToken;

		this.subscribeToCoinTrades(newToken);

		this.pruneMonitoredCoins();
	}

	public stopCoinMonitor(mint: string): void {
		if (!this.monitoredCoins[mint]) {
			console.warn(`Coin with mint ${mint} is not being monitored.`);
			return;
		}

		console.info(`Stopped monitoring coin with mint ${mint}`);
		delete this.monitoredCoins[mint];
	}

	public pruneMonitoredCoins(): void {
		const monitoredMints = Object.keys(this.monitoredCoins);

		if (monitoredMints.length <= this.maximumMonitoredCoins) {
			return;
		}

		console.info("Pruning monitored coins...");

		const untrippedMints = monitoredMints.filter(mint => !(mint in this.trippedMonitoredCoins));

		let sortedMints: string[];

		if (untrippedMints.length > 0) {
			// Sort untripped mints by `monitorStart` timestamp
			sortedMints = untrippedMints.sort((a, b) => {
				const aDate = new Date(this.monitoredCoins[a].monitorStart).getTime();
				const bDate = new Date(this.monitoredCoins[b].monitorStart).getTime();
				return aDate - bDate; // Oldest first
			});
		} else {
			// All coins are tripped, sort by `monitorStart` timestamp
			sortedMints = monitoredMints.sort((a, b) => {
				const aDate = new Date(this.monitoredCoins[a].monitorStart).getTime();
				const bDate = new Date(this.monitoredCoins[b].monitorStart).getTime();
				return aDate - bDate; // Oldest first
			});
		}

		// Remove excess coins
		const coinsToRemove = sortedMints.slice(0, monitoredMints.length - this.maximumMonitoredCoins);
		for (const mint of coinsToRemove) {
			console.info(`Pruned coin with mint ${mint}`);
			delete this.monitoredCoins[mint];
		}
	}

	public subscribeToCoinTrades(coin: Coin): void {
		const socket = io('https://frontend-api.pump.fun', {
			path: '/socket.io/',
			transports: ['websocket'],
		});

		socket.on('connect', () => {
			socket.emit('joinTradeRoom', {mint: coin.mint});
			console.log(`Joined trade room with mint ${coin.mint}`);
		});

		socket.on('disconnect', (reason) => {
			console.log(`Disconnected: ${reason}`);
		});

		socket.on('tradeCreated', (data) => {
			const trade: Trade = data;
			const solAmount = 5;
			const url = `https://pump.fun/coin/${trade.mint}`;
			if (trade.is_buy) {
				if (trade.sol_amount > solAmount * 1_000_000_000) {
					this.trippedMonitoredCoins[trade.mint] = trade;
					console.log(`Buy ${solAmount} SOL on ${url} by ${trade.user}`);
				}
			} else {
				if (trade.sol_amount > solAmount * 1_000_000_000) {
					if (trade.mint in this.trippedMonitoredCoins) {
						delete this.trippedMonitoredCoins[trade.mint];
					}
					console.log(`Sell ${solAmount} SOL on ${url} by ${trade.user}`);
				}
			}
		});

		socket.on('connect_error', (err) => {
			console.error('Connection error:', err);
		});
	}
}

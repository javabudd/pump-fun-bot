import {io} from "socket.io-client";
import CoinTrader from "./coin-trader";
import {Coin} from "../types/coin";
import {Trade} from "../types/trade";

export default class CoinMonitor {
	private readonly pumpFunSocketIoUrl = 'https://frontend-api.pump.fun';

	private maximumMonitoredCoins = 5;
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
	}

	public subscribeToCoinTrades(coin: Coin): void {
		const pumpPrivateKey = process.env['PUMP_PRIVATE_KEY'] ?? 'foo';
		const pumpApiKey = process.env['PUMP_API_KEY'] ?? 'bar';

		const trader = new CoinTrader(
			coin,
			pumpPrivateKey,
			pumpApiKey
		);

		const socket = io(
			this.pumpFunSocketIoUrl,
			{
				path: "/socket.io/",
				transports: ["websocket"],
			}
		);

		socket.on("connect", async () => {
			socket.emit("joinTradeRoom", {mint: coin.mint});

			await trader.startSniper();

			console.log(`Joined trade room for mint: ${coin.mint}`);
		});

		socket.on("tradeCreated", async (data) => {
			const trade: Trade = data;
			await this.handleTrade(trader, trade);

			if (trader.shouldTerminate) {
				delete this.monitoredCoins[coin.mint];
			}
		});

		socket.on("disconnect", (reason) => {
			console.log(`Disconnected from trade room: ${reason}`);
			trader.stopSniper();
			delete this.monitoredCoins[coin.mint];
		});

		socket.on("connect_error", (err) => {
			console.error("Socket connection error:", err);
			trader.stopSniper();
			delete this.monitoredCoins[coin.mint];
		});
	}

	private async handleTrade(trader: CoinTrader, trade: Trade): Promise<void> {
		await trader.addTrade(trade);

		if (trade.is_buy) {
			this.trippedMonitoredCoins[trade.mint] = trade;
		} else if (this.trippedMonitoredCoins[trade.mint]) {
			delete this.trippedMonitoredCoins[trade.mint];
		}
	}
}


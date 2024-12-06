import {connect, NatsConnection, StringCodec, Subscription} from 'nats.ws';
import {WebSocket} from 'ws';
import CoinMonitor from "./lib/coin-monitor";


(globalThis as any).WebSocket = WebSocket;

const monitor = new CoinMonitor();

(async function main(): Promise<void> {
	const url: string = 'wss://prod-v2.nats.realtime.pump.fun/';
	const sc = StringCodec();

	try {
		const nc: NatsConnection = await connect({
			servers: url,
			timeout: 1000,
			pedantic: false,
			user: 'subscriber',
			pass: 'lW5a9y20NceF6AE9'
		});

		console.log('Connected to NATS WebSocket server');

		const sub: Subscription = nc.subscribe('newCoinCreated.prod');
		console.log('Subscribed to newCoinCreated.prod');

		for await (const msg of sub) {
			const coin = JSON.parse(sc.decode(msg.data));
			monitor.startCoinMonitor(coin);
		}

		await nc.closed();
	} catch (err) {
		console.error('Error connecting to NATS WebSocket:', err);
	}
})();
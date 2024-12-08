import {connect, NatsConnection, StringCodec, Subscription} from 'nats.ws';
import {WebSocket} from 'ws';
import CoinMonitor from "./lib/coin-monitor";
import {Connection, Keypair, PublicKey,} from '@solana/web3.js';

(globalThis as any).WebSocket = WebSocket;

(async function main(): Promise<void> {
	const url: string = 'wss://prod-v2.nats.realtime.pump.fun/';
	const walletUrl: string = 'https://api.mainnet-beta.solana.com';
	const bondingCurveId = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
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

		const connection = new Connection(walletUrl, 'confirmed');
		const keypair = Keypair.generate();
		const privateKey = Array.from(keypair.secretKey);
		const secretKey = Uint8Array.from(privateKey);

		const wallet = Keypair.fromSecretKey(secretKey);
		const bondingCurveProgram = new PublicKey(bondingCurveId);

		const solanaWallet = {
			connection,
			wallet,
			bondingCurveProgram
		};

		for await (const msg of sub) {
			const coin = JSON.parse(sc.decode(msg.data));
			const monitor = new CoinMonitor(solanaWallet);

			monitor.startCoinMonitor(coin);
		}

		await nc.closed();
	} catch (err) {
		console.error('Error connecting to NATS WebSocket:', err);
	}
})();
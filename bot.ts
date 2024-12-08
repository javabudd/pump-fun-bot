import {connect, NatsConnection, StringCodec, Subscription} from 'nats.ws';
import {WebSocket} from 'ws';
import CoinMonitor from "./lib/coin-monitor";
import {Connection, Keypair, PublicKey,} from '@solana/web3.js';

process.loadEnvFile('.env');

(globalThis as any).WebSocket = WebSocket;

(async function main(): Promise<void> {
	const url: string = 'wss://prod-v2.nats.realtime.pump.fun/';
	const walletUrl: string = 'https://api.mainnet-beta.solana.com';
	const bondingCurveId = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
	const sc = StringCodec();

	let solanaWallet;

	try {
		const connection = new Connection(walletUrl, 'confirmed');
		const key = process.env.SOL_PRIVATE_KEY ?? '';
		const privateKeyArray = Uint8Array.from(key.split(',').map(Number));
		const keypair = Keypair.fromSecretKey(privateKeyArray);
		const wallet = Keypair.fromSecretKey(keypair.secretKey);
		const bondingCurveProgram = new PublicKey(bondingCurveId);

		solanaWallet = {
			connection,
			wallet,
			bondingCurveProgram
		};
	} catch (err) {
		console.error(err);
	}

	if (solanaWallet === undefined) {
		return;
	}

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
			const monitor = new CoinMonitor(solanaWallet);

			monitor.startCoinMonitor(coin);
		}

		await nc.closed();
	} catch (err) {
		console.error('Error connecting to NATS WebSocket:', err);
	}
})();
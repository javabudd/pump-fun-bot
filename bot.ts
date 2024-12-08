import {connect, NatsConnection, StringCodec, Subscription} from 'nats.ws';
import {WebSocket} from 'ws';
import CoinMonitor from "./lib/coin-monitor";
import {Connection, Keypair, PublicKey,} from '@solana/web3.js';
import {AnchorProvider, Program, Wallet} from "@project-serum/anchor";
import idl from './idl.json';
import {PumpFun} from "./types/pump-fun";

process.loadEnvFile('.env');

(globalThis as any).WebSocket = WebSocket;

(async function main(): Promise<void> {
	const url: string = 'wss://prod-v2.nats.realtime.pump.fun/';
	const walletUrl: string = 'https://api.mainnet-beta.solana.com';
	const bondingCurveId = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
	const sc = StringCodec();

	let connection, keypair;

	try {
		connection = new Connection(walletUrl, 'confirmed');
		const key = process.env.SOL_PRIVATE_KEY ?? '';
		const privateKeyArray = Uint8Array.from(key.split(',').map(Number));
		keypair = Keypair.fromSecretKey(privateKeyArray);
	} catch (err) {
		console.error('Error loading Solana wallet:', err);

		return;
	}

	const wallet = new Wallet(keypair);
	const provider = new AnchorProvider(
		connection,
		wallet,
		{commitment: 'confirmed'}
	);

	// @ts-ignore
	const anchorProgram = new Program(idl, bondingCurveId, provider);

	const [globalPDA] = PublicKey.findProgramAddressSync(
		[Buffer.from("global")],
		anchorProgram.programId
	);

	const globalAccount: any = await anchorProgram.account.global.fetch(globalPDA);

	if (!globalAccount) {
		console.error('No global account found!');

		return;
	}

	const pumpFun: PumpFun = {
		global: {
			feeRecipient: globalAccount.feeRecipient,
			pda: globalPDA,
			eventAuthority: globalAccount.authority
		},
		keypair,
		anchorProgram
	}

	const monitor = new CoinMonitor(pumpFun);

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
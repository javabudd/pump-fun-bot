import {Connection, Keypair, PublicKey} from "@solana/web3.js";

export type SolanaWallet = {
	connection: Connection;
	wallet: Keypair;
	bondingCurveProgram: PublicKey;
}
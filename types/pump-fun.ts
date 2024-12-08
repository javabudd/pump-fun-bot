import {Program} from "@project-serum/anchor";
import {Keypair, PublicKey} from "@solana/web3.js";

export type GlobalAccount = {
	feeRecipient: PublicKey;
	pda: PublicKey;
	eventAuthority: PublicKey;
}

export type PumpFun = {
	anchorProgram: Program;
	keypair: Keypair;
	global: GlobalAccount;
}
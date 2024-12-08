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
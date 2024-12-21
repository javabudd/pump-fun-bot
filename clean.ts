import { Connection, PublicKey, Keypair, clusterApiUrl } from "@solana/web3.js";
import { getAccount, closeAccount } from "@solana/spl-token";

process.loadEnvFile(".env");

// Initialize connection and wallet
const connection = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");
const key = process.env.SOL_PRIVATE_KEY ?? "";
const privateKeyArray = Uint8Array.from(key.split(",").map(Number));
const wallet = Keypair.fromSecretKey(privateKeyArray);

async function processTokenAccounts() {
  try {
    // Fetch all token accounts owned by the wallet
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      wallet.publicKey,
      {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      },
    );

    console.log(`Found ${tokenAccounts.value.length} token accounts.`);

    for (const { pubkey } of tokenAccounts.value) {
      try {
        // Get token account details
        const accountInfo = await getAccount(connection, pubkey);

        // Extract balance
        const balance = accountInfo.amount;

        console.log(`Token Account: ${pubkey.toBase58()}, Balance: ${balance}`);

        // Close accounts with a balance of 0
        if (balance === 0n) {
          console.log(`Closing token account: ${pubkey.toBase58()}`);
          await closeAccount(
            connection,
            wallet,
            pubkey,
            wallet.publicKey,
            wallet,
          );
          console.log(`Successfully closed account: ${pubkey.toBase58()}`);
        }
      } catch (error) {
        console.error(
          `Error processing account ${pubkey.toBase58()}: ${error}`,
        );
      }
    }
  } catch (error) {
    console.error(`Error fetching token accounts: ${error}`);
  }
}

processTokenAccounts().then(() => {
  console.log("Done processing token accounts.");
});

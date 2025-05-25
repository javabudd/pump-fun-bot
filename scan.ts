import CoinMonitor from "./lib/coin-monitor";
import { logger } from "./logger";

process.loadEnvFile(".env");

(async function main(): Promise<void> {
  const monitor = new CoinMonitor(
    undefined,
    undefined,
    1,
    process.env["AS_MOCK"]?.toLowerCase() === "true",
  );

  try {
    monitor.startScanner();
  } catch (err) {
    logger.error(`Error starting coin scanner: ${err}`);
  }
})();

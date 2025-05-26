import CoinMonitor from "./lib/coin-monitor";
import { logger } from "./logger";
import { program } from "commander";

process.loadEnvFile(".env");
program.option("-m, --max-mon <number>", "Maximum monitored coins", parseInt);
program.parse();

(async function main(): Promise<void> {
  const options = program.opts();
  console.log(options);

  const monitor = new CoinMonitor(
    undefined,
    undefined,
    parseInt(options.maxMon),
    true,
  );

  try {
    monitor.startScanner({
      marketCap: 30000,
      solAmount: 5,
      socialConditionals: (event) => {
        return event.twitter !== null && event.telegram !== null;
      },
    });
  } catch (err) {
    logger.error(`Error starting coin scanner: ${err}`);
  }
})();

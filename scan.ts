import CoinMonitor from "./lib/coin-monitor";
import { logger } from "./logger";
import { program } from "commander";

process.loadEnvFile(".env");
program.option("-m, --max-mon <number>", "Maximum monitored coins", parseInt);
program.option("-s, --slack <string>", "Slack token to use for scanner alerts");
program.parse();

(async function main(): Promise<void> {
  const options = program.opts();

  const monitor = new CoinMonitor(
    undefined,
    undefined,
    parseInt(options.maxMon),
    true,
  );

  try {
    monitor.startScanner({
      marketCap: 10000,
      solAmount: 4,
      socialConditionals: (event) => {
        return event.twitter !== null || event.telegram !== null;
      },
    });
  } catch (err) {
    logger.error(`Error starting coin scanner: ${err}`);
  }
})();

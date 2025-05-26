import CoinMonitor from "./lib/coin-monitor";
import { logger } from "./logger";
import { program } from "commander";
import { SlackClient } from "./lib/notifications";

process.loadEnvFile(".env");
program.option("-m, --max-mon <number>", "Maximum monitored coins", parseInt);
program.option("--slack-token <string>", "Slack token for scanner alerts");
program.option(
  "--slack-channel <string>",
  "Slack channel ID for scanner alerts",
);
program.parse();

(async function main(): Promise<void> {
  const options = program.opts();

  if (options.slackToken && !options.slackChannel) {
    throw new Error("--slack-channel must be passed with --slack-token");
  }

  let slackClient;
  if (options.slackToken && options.slackChannel) {
    slackClient = new SlackClient(options.slackToken, options.slackChannel);
  }

  const monitor = new CoinMonitor(
    undefined,
    undefined,
    parseInt(options.maxMon),
    true,
    slackClient,
  );

  try {
    monitor.startScanner({
      marketCap: 10000,
      solAmount: 1,
      socialConditionals: (event) => {
        return event.twitter !== null || event.telegram !== null;
      },
    });
  } catch (err) {
    logger.error(`Error starting coin scanner: ${err}`);
  }
})();

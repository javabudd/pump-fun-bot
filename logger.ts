import pino from "pino";

const customTransport = {
  write: (log: never) => {
    const parsed = JSON.parse(log);
    const { level, msg } = parsed;

    // ANSI color codes for each level
    let color = "\x1b[0m"; // default (reset)

    switch (level) {
      case 1: // error
        color = "\x1b[31m"; // red
        break;
      case 2: // info
        color = "\x1b[34m"; // blue
        break;
      case 3: // warn
        color = "\x1b[33m"; // yellow
        break;
      case 7: // attemptBuy
        color = "\x1b[36m"; // cyan
        break;
      case 8: // buy
        color = "\x1b[32m"; // green
        break;
      case 9: // sell
        color = "\x1b[35m"; // magenta
        break;
      default:
        color = "\x1b[0m"; // fallback/reset
        break;
    }

    process.stdout.write(`${color}${msg}\x1b[0m\n`);
  },
};

export const logger = pino(
  {
    customLevels: {
      error: 1,
      info: 2,
      warn: 3,
      attemptBuy: 7,
      buy: 8,
      sell: 9,
    },
    useOnlyCustomLevels: true,
  },
  customTransport,
);

import pino from "pino";

const customTransport = {
  write: (log: never) => {
    const parsed = JSON.parse(log);
    const { level, msg } = parsed;

    let color = "\x1b[0m"; // default

    switch (level) {
      case 1:
        color = "\x1b[31m";
        break; // error - red
      case 2:
        color = "\x1b[34m";
        break; // info - blue
      case 3:
        color = "\x1b[33m";
        break; // warn - yellow
      case 7:
        color = "\x1b[36m";
        break; // attemptBuy - cyan
      case 8:
        color = "\x1b[32m";
        break; // buy - green
      case 9:
        color = "\x1b[35m";
        break; // sell - magenta
      case 10:
        color = "\x1b[93m";
        break; // attemptSell - bright yellow
      default:
        color = "\x1b[0m";
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
      attemptSell: 10,
    },
    useOnlyCustomLevels: true,
  },
  customTransport,
);

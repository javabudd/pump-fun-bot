import { Trade } from "../types/trade";
import { WebClient } from "@slack/web-api";
import { ScannerOptions } from "./coin-monitor";

export interface NotificationClient {
  send(trade: Trade): Promise<void>;
  sendOptions(options: ScannerOptions): Promise<void>;
}

export class SlackClient implements NotificationClient {
  private readonly client;

  public constructor(
    slackToken: string,
    private readonly slackChannelId: string,
  ) {
    this.client = new WebClient(slackToken);
  }

  async send(trade: Trade): Promise<void> {
    const url = `https://pump.fun/coin/${trade.mint}`;

    await this.client.chat.postMessage({
      channel: this.slackChannelId,
      text: `Big trade found: ${trade.name} - ${url}`,
    });
  }

  async sendOptions(options: ScannerOptions) {
    await this.client.chat.postMessage({
      channel: this.slackChannelId,
      text: `Scanner options: ${options}`,
    });
  }
}

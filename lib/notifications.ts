import { Trade } from "../types/trade";
import { WebClient } from "@slack/web-api";

export interface NotificationClient {
  send(trade: Trade): void;
}

export class SlackClient implements NotificationClient {
  private readonly client;

  public constructor(
    slackToken: string,
    private readonly slackChannelId: string,
  ) {
    this.client = new WebClient(slackToken);
  }

  async send(trade: Trade) {
    const url = `https://pump.fun/coin/${trade.mint}`;

    await this.client.chat.postMessage({
      channel: this.slackChannelId,
      text: `Big trade found: ${trade.name} - ${url}`,
    });
  }
}

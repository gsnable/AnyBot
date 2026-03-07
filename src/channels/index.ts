import type { IChannel, ChannelCallbacks } from "./types.js";
import { readChannelsConfig } from "./config.js";
import { FeishuChannel } from "./feishu.js";
import { logger } from "../logger.js";

type ChannelFactory = () => IChannel;

const channelFactories: Record<string, ChannelFactory> = {
  feishu: () => new FeishuChannel(),
};

export function getRegisteredChannelTypes(): string[] {
  return Object.keys(channelFactories);
}

export async function startAllChannels(
  callbacks: ChannelCallbacks,
): Promise<IChannel[]> {
  const config = readChannelsConfig();
  const started: IChannel[] = [];

  for (const [type, factory] of Object.entries(channelFactories)) {
    const channelConfig = config[type];
    if (!channelConfig?.enabled) {
      logger.info("channel.skipped", { type, reason: "disabled" });
      continue;
    }

    try {
      const channel = factory();
      await channel.start(callbacks);
      started.push(channel);
      logger.info("channel.started", { type });
    } catch (error) {
      logger.error("channel.start_failed", { type, error });
    }
  }

  return started;
}

export { readChannelsConfig, readChannelConfig, updateChannelConfig } from "./config.js";
export type { IChannel, ChannelCallbacks, ChannelsConfig, ChannelConfig, FeishuChannelConfig } from "./types.js";

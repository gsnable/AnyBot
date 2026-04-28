export interface ChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  ownerChatId?: string;
  [key: string]: unknown;
}

export interface FeishuChannelConfig extends ChannelConfig {
  groupChatMode: "mention" | "all";
  botOpenId: string;
  ackReaction: string;
}

export interface QQBotChannelConfig extends ChannelConfig {
  [key: string]: unknown;
}

export interface TelegramChannelConfig {
  enabled: boolean;
  token: string;
  ownerChatId?: string;
  [key: string]: unknown;
}

export interface ChannelsConfig {
  [channelType: string]: ChannelConfig | TelegramChannelConfig | undefined;
  feishu?: FeishuChannelConfig;
  qqbot?: QQBotChannelConfig;
  telegram?: TelegramChannelConfig;
}

export interface ProviderInfo {
  type: string;
  displayName: string;
  isCurrent: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  isCurrent: boolean;
}

export interface ChannelCallbacks {
  generateReply: (
    chatId: string,
    userText: string,
    imagePaths?: string[],
    source?: string,
  ) => Promise<string>;
  sendProgress: (chatId: string, message: string) => Promise<void>;
  retryReply: (chatId: string, source?: string) => Promise<string>;
  resetSession: (chatId: string, source?: string) => void;
  stopSession: (chatId: string) => Promise<void>;
  listUserSessions: (chatId: string, source: string) => Promise<any[]>;
  getSessionMessages: (dbSessionId: string) => Promise<any[]>;
  resumeSession: (chatId: string, source: string, dbSessionId: string) => Promise<void>;
  listProviders: () => ProviderInfo[];
  switchProvider: (providerType: string) => { success: boolean; message: string };
  listModels: () => ModelInfo[];
  switchModel: (modelId: string) => { success: boolean; message: string };
  getWorkdir: (chatId: string, source: string) => string;
  setWorkdir: (chatId: string, source: string, workdir: string) => void;
}

export interface IChannel {
  readonly type: string;
  start(callbacks: ChannelCallbacks): Promise<void>;
  stop(): Promise<void>;
  sendToOwner(text: string): Promise<void>;
}

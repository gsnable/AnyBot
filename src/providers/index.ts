import type { IProvider } from "./types.js";
import { CodexProvider } from "./codex.js";
import { GeminiCliProvider } from "./gemini-cli.js";
import { CursorCliProvider } from "./cursor-cli.js";
import { QoderCliProvider } from "./qoder-cli.js";
import { ClaudeCliProvider } from "./claude-cli.js";

type ProviderFactory = (config?: Record<string, unknown>) => IProvider;

const providerFactories: Record<string, ProviderFactory> = {
  codex: (config) => new CodexProvider({ bin: config?.bin as string | undefined }),
  "gemini-cli": (config) =>
    new GeminiCliProvider({
      bin: config?.bin as string | undefined,
      approvalMode: config?.approvalMode as string | undefined,
    }),
  "claude-code": (config) =>
    new ClaudeCliProvider({
      bin: config?.bin as string | undefined,
    }),
  "cursor-cli": (config) =>

    new CursorCliProvider({
      bin: config?.bin as string | undefined,
      workspace: config?.workspace as string | undefined,
      apiKey: config?.apiKey as string | undefined,
    }),
  "qoder-cli": (config) =>
    new QoderCliProvider({
      bin: config?.bin as string | undefined,
      maxTurns: config?.maxTurns as number | undefined,
    }),
};

export function getRegisteredProviderTypes(): string[] {
  return Object.keys(providerFactories);
}

export function getDefaultProviderConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "codex":
      return { bin: process.env.CODEX_BIN };
    case "gemini-cli":
      return {
        bin: process.env.GEMINI_CLI_BIN,
        approvalMode: process.env.GEMINI_CLI_APPROVAL_MODE || "yolo",
      };
    case "claude-code":
      return {
        bin: process.env.CLAUDE_CLI_BIN,
        approvalMode: process.env.CLAUDE_CLI_APPROVAL_MODE || "yolo",
      };
    case "cursor-cli":
      return {
        bin: process.env.CURSOR_CLI_BIN,
        workspace: process.env.CURSOR_CLI_WORKSPACE,
        apiKey: process.env.CURSOR_API_KEY,
      };
    case "qoder-cli":
      return {
        bin: process.env.QODER_CLI_BIN,
        maxTurns: process.env.QODER_CLI_MAX_TURNS
          ? parseInt(process.env.QODER_CLI_MAX_TURNS, 10)
          : undefined,
      };
    default:
      return {};
  }
}

export function createProvider(type: string, config?: Record<string, unknown>): IProvider {
  const factory = providerFactories[type];
  if (!factory) {
    throw new Error(
      `不支持的 Provider: ${type}。可用: ${Object.keys(providerFactories).join(", ")}`,
    );
  }
  const effectiveConfig = { ...getDefaultProviderConfig(type), ...(config || {}) };
  return factory(effectiveConfig);
}

let currentProvider: IProvider | null = null;

export function getProvider(): IProvider {
  if (!currentProvider) {
    throw new Error("Provider 尚未初始化");
  }
  return currentProvider;
}

export function initProvider(type: string, config?: Record<string, unknown>): IProvider {
  currentProvider = createProvider(type, config);
  return currentProvider;
}

export function switchProvider(type: string, config?: Record<string, unknown>): IProvider {
  currentProvider = createProvider(type, config);
  return currentProvider;
}

export type {
  IProvider,
  RunOptions,
  RunResult,
  ProviderModel,
  ProviderCapabilities,
  ProviderConfig,
} from "./types.js";
export { CodexProvider } from "./codex.js";
export { GeminiCliProvider, ProviderSessionNotFoundError } from "./gemini-cli.js";
export { ClaudeCliProvider } from "./claude-cli.js";
export { CursorCliProvider } from "./cursor-cli.js";
export { QoderCliProvider } from "./qoder-cli.js";
export {
  ProviderTimeoutError,
  ProviderProcessError,
  ProviderEmptyOutputError,
  ProviderParseError,
} from "./codex.js";

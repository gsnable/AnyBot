import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import {
  getProvider,
  getRegisteredProviderTypes,
  switchProvider,
  createProvider,
} from "../providers/index.js";
import { getDataDir } from "../shared.js";

const CONFIG_PATH = path.join(getDataDir(), "model-config.json");

export interface ModelEntry {
  id: string;
  name: string;
  description: string;
}

export interface ModelConfig {
  provider: string;
  currentModel: string;
  models: ModelEntry[];
  lastSelected: Record<string, string>;
}

function buildDefaultConfig(): ModelConfig {
  const provider = getProvider();
  const models = provider.listModels();
  return {
    provider: provider.type,
    currentModel: models[0]?.id ?? "",
    models,
    lastSelected: { [provider.type]: models[0]?.id ?? "" },
  };
}

let memoryCachedConfig: ModelConfig | null = null;

function writeModelConfigFile(config: ModelConfig): void {
  const tmpPath = `${CONFIG_PATH}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmpPath, CONFIG_PATH);
  memoryCachedConfig = config;
}

function ensureConfig(): void {
  if (!existsSync(CONFIG_PATH)) {
    writeModelConfigFile(buildDefaultConfig());
  }
}

export function readModelConfig(): ModelConfig {
  ensureConfig();
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw) as ModelConfig;

  if (!config.lastSelected) {
    config.lastSelected = {};
  }

  const provider = getProvider();
  const needsRefresh =
    config.provider !== provider.type ||
    !config.models ||
    config.models.length === 0 ||
    (config.models.length === 1 && config.models[0].id === "auto");

  if (needsRefresh) {
    config.provider = provider.type;
    config.models = provider.listModels();
    config.currentModel = config.lastSelected[provider.type] || config.models[0]?.id || "";
    writeModelConfigFile(config);
  }

  memoryCachedConfig = config;
  return config;
}

export function getCurrentModel(): string {
  return readModelConfig().currentModel;
}

export function getCurrentProviderType(): string {
  return readModelConfig().provider;
}

export function setCurrentModel(modelId: string): ModelConfig {
  const config = readModelConfig();
  const valid = config.models.some((m) => m.id === modelId);
  if (!valid) {
    throw new Error(`不支持的模型: ${modelId}`);
  }
  config.currentModel = modelId;
  config.lastSelected[config.provider] = modelId;
  writeModelConfigFile(config);
  return config;
}

export function setCurrentProvider(
  providerType: string,
  providerConfig?: Record<string, unknown>,
): ModelConfig {
  const registered = getRegisteredProviderTypes();
  if (!registered.includes(providerType)) {
    throw new Error(`不支持的 Provider: ${providerType}。可用: ${registered.join(", ")}`);
  }

  const config = readModelConfig();
  config.lastSelected[config.provider] = config.currentModel;
  config.provider = providerType;

  const newProvider = switchProvider(providerType, providerConfig);
  config.models = newProvider.listModels();
  config.currentModel = config.lastSelected[providerType] || config.models[0]?.id || "";

  writeModelConfigFile(config);
  return config;
}

export function getProviderTypes(): Array<{
  type: string;
  displayName: string;
  capabilities: Record<string, boolean>;
}> {
  return getRegisteredProviderTypes().map((type) => {
    const p = createProvider(type);
    return {
      type: p.type,
      displayName: p.displayName,
      capabilities: { ...p.capabilities },
    };
  });
}

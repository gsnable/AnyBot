import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../.data/model-config.json");

export interface ModelEntry {
  id: string;
  name: string;
  description: string;
}

export interface ModelConfig {
  currentModel: string;
  models: ModelEntry[];
}

const DEFAULT_CONFIG: ModelConfig = {
  currentModel: "gpt-5.3-codex",
  models: [
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", description: "默认编程模型" },
    { id: "gpt-5.4", name: "GPT-5.4", description: "最新通用模型" },
    { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", description: "稳定编程模型" },
  ],
};

function ensureConfig(): void {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  }
}

export function readModelConfig(): ModelConfig {
  ensureConfig();
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as ModelConfig;
}

export function getCurrentModel(): string {
  return readModelConfig().currentModel;
}

export function setCurrentModel(modelId: string): ModelConfig {
  const config = readModelConfig();
  const valid = config.models.some((m) => m.id === modelId);
  if (!valid) {
    throw new Error(`不支持的模型: ${modelId}`);
  }
  config.currentModel = modelId;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  return config;
}

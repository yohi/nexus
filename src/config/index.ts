import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config, EmbeddingConfig } from '../types/index.js';

export interface LoadConfigOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  configFileName?: string;
}

const DEFAULT_EMBEDDING: EmbeddingConfig = {
  provider: 'ollama',
  model: 'nomic-embed-text',
  dimensions: 64,
  baseUrl: 'http://127.0.0.1:11434',
  maxConcurrency: 2,
  batchSize: 32,
  retryCount: 3,
  retryBaseDelayMs: 250,
};

const DEFAULT_CONFIG = (projectRoot: string): Config => ({
  projectRoot,
  storage: {
    rootDir: path.join(projectRoot, '.nexus'),
    metadataDbPath: path.join(projectRoot, '.nexus', 'metadata.db'),
    vectorDbPath: path.join(projectRoot, '.nexus', 'vectors'),
  },
  watcher: {
    debounceMs: 100,
    maxQueueSize: 10_000,
    fullScanThreshold: 5_000,
  },
  embedding: { ...DEFAULT_EMBEDDING },
});

export const loadConfig = async (options: LoadConfigOptions): Promise<Config> => {
  const env = options.env ?? process.env;
  const configPath = path.join(options.projectRoot, options.configFileName ?? '.nexus.json');
  const defaults = DEFAULT_CONFIG(options.projectRoot);
  const fileConfig = await readJsonFile(configPath);

  const merged: Config = {
    projectRoot: options.projectRoot,
    storage: {
      rootDir: asString(env.NEXUS_STORAGE_ROOT_DIR) ?? fileConfig.storage?.rootDir ?? defaults.storage.rootDir,
      metadataDbPath:
        asString(env.NEXUS_STORAGE_METADATA_DB_PATH) ?? fileConfig.storage?.metadataDbPath ?? defaults.storage.metadataDbPath,
      vectorDbPath:
        asString(env.NEXUS_STORAGE_VECTOR_DB_PATH) ?? fileConfig.storage?.vectorDbPath ?? defaults.storage.vectorDbPath,
    },
    watcher: {
      debounceMs: asPositiveInt(env.NEXUS_WATCHER_DEBOUNCE_MS) ?? fileConfig.watcher?.debounceMs ?? defaults.watcher.debounceMs,
      maxQueueSize:
        asPositiveInt(env.NEXUS_WATCHER_MAX_QUEUE_SIZE) ?? fileConfig.watcher?.maxQueueSize ?? defaults.watcher.maxQueueSize,
      fullScanThreshold:
        asPositiveInt(env.NEXUS_WATCHER_FULL_SCAN_THRESHOLD) ??
        fileConfig.watcher?.fullScanThreshold ??
        defaults.watcher.fullScanThreshold,
    },
    embedding: {
      provider: asProvider(env.NEXUS_EMBEDDING_PROVIDER) ?? fileConfig.embedding?.provider ?? defaults.embedding.provider,
      model: asString(env.NEXUS_EMBEDDING_MODEL) ?? fileConfig.embedding?.model ?? defaults.embedding.model,
      dimensions:
        asPositiveInt(env.NEXUS_EMBEDDING_DIMENSIONS) ?? fileConfig.embedding?.dimensions ?? defaults.embedding.dimensions,
      baseUrl: asString(env.NEXUS_EMBEDDING_BASE_URL) ?? fileConfig.embedding?.baseUrl ?? defaults.embedding.baseUrl,
      apiKey: asString(env.NEXUS_EMBEDDING_API_KEY) ?? fileConfig.embedding?.apiKey ?? defaults.embedding.apiKey,
      maxConcurrency:
        asPositiveInt(env.NEXUS_EMBEDDING_MAX_CONCURRENCY) ??
        fileConfig.embedding?.maxConcurrency ??
        defaults.embedding.maxConcurrency,
      batchSize:
        asPositiveInt(env.NEXUS_EMBEDDING_BATCH_SIZE) ?? fileConfig.embedding?.batchSize ?? defaults.embedding.batchSize,
      retryCount:
        asNonNegativeInt(env.NEXUS_EMBEDDING_RETRY_COUNT) ?? fileConfig.embedding?.retryCount ?? defaults.embedding.retryCount,
      retryBaseDelayMs:
        asPositiveInt(env.NEXUS_EMBEDDING_RETRY_BASE_DELAY_MS) ??
        fileConfig.embedding?.retryBaseDelayMs ??
        defaults.embedding.retryBaseDelayMs,
    },
  };

  return merged;
};

const asString = (value: string | undefined): string | undefined => (value && value.trim() !== '' ? value : undefined);
const asPositiveInt = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};
const asNonNegativeInt = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};
const asProvider = (value: string | undefined): EmbeddingConfig['provider'] | undefined => {
  if (value === 'ollama' || value === 'openai-compat' || value === 'test') {
    return value;
  }
  return undefined;
};

const readJsonFile = async (configPath: string): Promise<Partial<Config>> => {
  try {
    const raw = await readFile(configPath, 'utf8');
    return JSON.parse(raw) as Partial<Config>;
  } catch {
    return {};
  }
};

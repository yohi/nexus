import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Config, EmbeddingConfig, IndexingConfig } from '../types/index.js';

export interface LoadConfigOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  configFileName?: string;
}

export const DEFAULT_OLLAMA_NUM_THREAD = 2;
export const MAX_OLLAMA_NUM_THREAD = 16;

const DEFAULT_EMBEDDING: EmbeddingConfig = {
  provider: 'ollama',
  model: 'nomic-embed-text',
  dimensions: 768,
  baseUrl: 'http://127.0.0.1:11434',
  maxConcurrency: 1,
  batchSize: 32,
  retryCount: 3,
  retryBaseDelayMs: 250,
  timeoutMs: 120_000,
  ollamaNumThread: DEFAULT_OLLAMA_NUM_THREAD,
};

const DEFAULT_INDEXING: IndexingConfig = {
  maxFileBytes: 1_048_576,
  maxChunkChars: 6_000,
  chunkConcurrency: 2,
  embedBatchWindowSize: 16,
};

export const SECRET_IGNORE_PATHS = ['.env', '.env.*'];

export const DEFAULT_BATCH_SIZE = 1000;

const DEFAULT_CONFIG = (projectRoot: string): Config => ({
  projectRoot,
  storage: {
    rootDir: path.join(projectRoot, '.nexus'),
    metadataDbPath: path.join(projectRoot, '.nexus', 'metadata.db'),
    vectorDbPath: path.join(projectRoot, '.nexus', 'vectors'),
    batchSize: DEFAULT_BATCH_SIZE,
  },
  watcher: {
    debounceMs: 100,
    maxQueueSize: 10_000,
    fullScanThreshold: 5_000,
    ignorePaths: [
      'node_modules',
      '.git',
      '.worktrees',
      '.nexus',
      'dist',
      'build',
      'out',
      'coverage',
      '.cache',
      '.parcel-cache',
      'venv',
      '.venv',
      'env',
      '.idea',
      '.vscode',
      '.DS_Store',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      '*.lock',
      '__pycache__',
      '*.pyc',
      '.pytest_cache',
      '.mypy_cache',
      '.ruff_cache',
    ],
  },
  embedding: { ...DEFAULT_EMBEDDING },
  indexing: { ...DEFAULT_INDEXING },
  packageMode: false,
});

export const loadConfig = async (options: LoadConfigOptions): Promise<Config> => {
  const env = options.env ?? process.env;
  const configPath = path.join(options.projectRoot, options.configFileName ?? '.nexus.json');
  const defaults = DEFAULT_CONFIG(options.projectRoot);
  const fileConfig = await readJsonFile(configPath);
  const projectName = validateString(fileConfig.projectName) ?? asString(env.NEXUS_PROJECT_NAME);

  const merged: Config = {
    projectRoot: options.projectRoot,
    storage: {
      rootDir: asString(env.NEXUS_STORAGE_ROOT_DIR) ?? validateString(fileConfig.storage?.rootDir) ?? defaults.storage.rootDir,
      metadataDbPath:
        asString(env.NEXUS_STORAGE_METADATA_DB_PATH) ??
        validateString(fileConfig.storage?.metadataDbPath) ??
        defaults.storage.metadataDbPath,
      vectorDbPath:
        asString(env.NEXUS_STORAGE_VECTOR_DB_PATH) ?? validateString(fileConfig.storage?.vectorDbPath) ?? defaults.storage.vectorDbPath,
      batchSize: asPositiveInt(env.NEXUS_STORAGE_BATCH_SIZE) ?? validatePositiveInt(fileConfig.storage?.batchSize) ?? defaults.storage.batchSize,
    },
    watcher: {
      debounceMs: asPositiveInt(env.NEXUS_WATCHER_DEBOUNCE_MS) ?? validatePositiveInt(fileConfig.watcher?.debounceMs) ?? defaults.watcher.debounceMs,
      maxQueueSize:
        asPositiveInt(env.NEXUS_WATCHER_MAX_QUEUE_SIZE) ?? validatePositiveInt(fileConfig.watcher?.maxQueueSize) ?? defaults.watcher.maxQueueSize,
      fullScanThreshold:
        asPositiveInt(env.NEXUS_WATCHER_FULL_SCAN_THRESHOLD) ??
        validatePositiveInt(fileConfig.watcher?.fullScanThreshold) ??
        defaults.watcher.fullScanThreshold,
      ignorePaths: withSecretIgnorePaths(
        asStringList(env.NEXUS_WATCHER_IGNORE_PATHS) ?? validateStringList(fileConfig.watcher?.ignorePaths) ?? defaults.watcher.ignorePaths,
      ),
    },
    embedding: {
      provider: asProvider(env.NEXUS_EMBEDDING_PROVIDER) ?? validateProvider(fileConfig.embedding?.provider) ?? defaults.embedding.provider,
      model: asString(env.NEXUS_EMBEDDING_MODEL) ?? validateString(fileConfig.embedding?.model) ?? defaults.embedding.model,
      dimensions:
        asPositiveInt(env.NEXUS_EMBEDDING_DIMENSIONS) ?? validatePositiveInt(fileConfig.embedding?.dimensions) ?? defaults.embedding.dimensions,
      baseUrl: asString(env.NEXUS_EMBEDDING_BASE_URL) ?? validateString(fileConfig.embedding?.baseUrl) ?? defaults.embedding.baseUrl,
      apiKey: asString(env.NEXUS_EMBEDDING_API_KEY) ?? validateString(fileConfig.embedding?.apiKey) ?? defaults.embedding.apiKey,
      region: asString(env.NEXUS_EMBEDDING_REGION) ?? validateString(fileConfig.embedding?.region) ?? defaults.embedding.region,
      profile: asString(env.NEXUS_EMBEDDING_PROFILE) ?? validateString(fileConfig.embedding?.profile) ?? defaults.embedding.profile,
      maxConcurrency:
        asPositiveInt(env.NEXUS_EMBEDDING_MAX_CONCURRENCY) ??
        validatePositiveInt(fileConfig.embedding?.maxConcurrency) ??
        defaults.embedding.maxConcurrency,
      batchSize:
        asPositiveInt(env.NEXUS_EMBEDDING_BATCH_SIZE) ?? validatePositiveInt(fileConfig.embedding?.batchSize) ?? defaults.embedding.batchSize,
      retryCount:
        asNonNegativeInt(env.NEXUS_EMBEDDING_RETRY_COUNT) ?? validateNonNegativeInt(fileConfig.embedding?.retryCount) ?? defaults.embedding.retryCount,
      retryBaseDelayMs:
        asPositiveInt(env.NEXUS_EMBEDDING_RETRY_BASE_DELAY_MS) ??
        validatePositiveInt(fileConfig.embedding?.retryBaseDelayMs) ??
        defaults.embedding.retryBaseDelayMs,
      timeoutMs:
        asPositiveInt(env.NEXUS_EMBEDDING_TIMEOUT_MS) ??
        validatePositiveInt(fileConfig.embedding?.timeoutMs) ??
        defaults.embedding.timeoutMs,
      ollamaNumThread:
        asBoundedPositiveInt(env.NEXUS_OLLAMA_NUM_THREAD, MAX_OLLAMA_NUM_THREAD) ??
        validateBoundedPositiveInt(fileConfig.embedding?.ollamaNumThread, MAX_OLLAMA_NUM_THREAD) ??
        defaults.embedding.ollamaNumThread,
    },
    indexing: {
      maxFileBytes:
        asPositiveInt(env.NEXUS_INDEXING_MAX_FILE_BYTES) ??
        validatePositiveInt(fileConfig.indexing?.maxFileBytes) ??
        defaults.indexing.maxFileBytes,
      maxChunkChars:
        asNonNegativeInt(env.NEXUS_INDEXING_MAX_CHUNK_CHARS) ??
        validateNonNegativeInt(fileConfig.indexing?.maxChunkChars) ??
        defaults.indexing.maxChunkChars,
      chunkConcurrency:
        asPositiveInt(env.NEXUS_INDEXING_CHUNK_CONCURRENCY) ??
        validatePositiveInt(fileConfig.indexing?.chunkConcurrency) ??
        defaults.indexing.chunkConcurrency,
      embedBatchWindowSize:
        asPositiveInt(env.NEXUS_INDEXING_EMBED_BATCH_WINDOW_SIZE) ??
        validatePositiveInt(fileConfig.indexing?.embedBatchWindowSize) ??
        defaults.indexing.embedBatchWindowSize,
    },
    metricsPort:
      asPortNumber(env.NEXUS_METRICS_PORT) ??
      validatePortNumber(fileConfig.metricsPort) ??
      undefined,
    aggregatorPort:
      validatePortNumber(fileConfig.aggregatorPort) ??
      asPortNumber(env.NEXUS_AGGREGATOR_PORT) ??
      undefined,
    packageMode:
      asBoolean(env.NEXUS_PACKAGE_MODE) ??
      validateBoolean(fileConfig.packageMode) ??
      false,
  };

  return projectName === undefined ? merged : { ...merged, projectName };
};

const asString = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed !== '' ? trimmed : undefined;
};

const validateString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed !== '' ? trimmed : undefined;
};

const asPositiveInt = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const validatePositiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

/** Parses environment values that must be integers in the inclusive range 1..max. */
const asBoundedPositiveInt = (
  value: string | undefined,
  max: number,
): number | undefined => {
  const parsed = asPositiveInt(value);
  return parsed !== undefined && parsed <= max ? parsed : undefined;
};

/** Validates config-file values that must be integers in the inclusive range 1..max. */
const validateBoundedPositiveInt = (
  value: unknown,
  max: number,
): number | undefined => {
  const parsed = validatePositiveInt(value);
  return parsed !== undefined && parsed <= max ? parsed : undefined;
};

const asPortNumber = (value: string | undefined): number | undefined => {
  const parsed = asPositiveInt(value);
  return parsed !== undefined && parsed <= 65535 ? parsed : undefined;
};

const validatePortNumber = (value: unknown): number | undefined => {
  const parsed = validatePositiveInt(value);
  return parsed !== undefined && parsed <= 65535 ? parsed : undefined;
};

const asNonNegativeInt = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const validateNonNegativeInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

const asBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return undefined;
};

const validateBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asProvider = (value: string | undefined): EmbeddingConfig['provider'] | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return isProvider(trimmed) ? trimmed : undefined;
};

const validateProvider = (value: unknown): EmbeddingConfig['provider'] | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return isProvider(trimmed) ? trimmed : undefined;
};

const isProvider = (value: unknown): value is EmbeddingConfig['provider'] => {
  return value === 'ollama' || value === 'openai-compat' || value === 'bedrock' || value === 'test';
};

const asStringList = (value: string | undefined): string[] | undefined => {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
};

const validateStringList = (value: unknown): string[] | undefined => {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  return undefined;
};

const withSecretIgnorePaths = (paths: string[] | undefined): string[] => {
  const result = [...(paths ?? [])];
  for (const secret of SECRET_IGNORE_PATHS) {
    if (!result.includes(secret)) {
      result.push(secret);
    }
  }
  return result;
};

const readJsonFile = async (configPath: string): Promise<Partial<Config>> => {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Configuration file "${configPath}" must contain a top-level object.`);
    }

    return parsed as Partial<Config>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
};

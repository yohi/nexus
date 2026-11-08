import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';

import type { Config, EmbeddingConfig, IndexingConfig, LspConfig } from '../types/index.js';

export interface LoadConfigOptions {
  projectRoot: string;
  configFileName?: string;
  env?: NodeJS.ProcessEnv;
  /** "v2-http" のときのみ HTTP v2 設定を読み込み、local-only 制約を適用する。 */
  transportMode?: 'stdio' | 'v1-http' | 'v2-http';
}

export const DEFAULT_OLLAMA_NUM_THREAD = 2;
export const MAX_OLLAMA_NUM_THREAD = 16;
export const DEFAULT_OLLAMA_LOCK_TIMEOUT_MS = 300_000;

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
  ollamaLockTimeoutMs: DEFAULT_OLLAMA_LOCK_TIMEOUT_MS,
};

const DEFAULT_INDEXING: IndexingConfig = {
  maxFileBytes: 1_048_576,
  maxChunkChars: 6_000,
  chunkConcurrency: 2,
  embedBatchWindowSize: 16,
};

const DEFAULT_LSP: LspConfig = {
  enabled: false,
  typescript: { executable: null, args: ['--stdio'] },
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
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
      '.agents/',
      'AGENTS.md',
      '.git',
      '.claude',
      '.worktrees',
      '.nexus',
      '.nexus/',
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
  lsp: { ...DEFAULT_LSP, typescript: { ...DEFAULT_LSP.typescript, args: [...DEFAULT_LSP.typescript.args] } },
});

export const loadConfig = async (options: LoadConfigOptions): Promise<Config> => {
  const env = options.env ?? process.env;
  const configPath = path.join(options.projectRoot, options.configFileName ?? '.nexus.json');
  const defaults = DEFAULT_CONFIG(options.projectRoot);
  const fileConfig = await readJsonFile(configPath);
  const projectName = validateString(fileConfig.projectName) ?? asString(env.NEXUS_PROJECT_NAME);

  const lspResult = resolveLspConfig(env, fileConfig.lsp);

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
      headers: asJsonRecord(env.NEXUS_EMBEDDING_HEADERS) ?? validateHeaders(fileConfig.embedding?.headers),
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
      ollamaLockTimeoutMs:
        asPositiveInt(env.NEXUS_OLLAMA_LOCK_TIMEOUT_MS) ??
        validatePositiveInt(fileConfig.embedding?.ollamaLockTimeoutMs) ??
        defaults.embedding.ollamaLockTimeoutMs,
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
    ...(options.transportMode === 'v2-http'
      ? {
          http: {
            host:
              asString(env.NEXUS_HTTP_HOST) ??
              validateString(fileConfig.http?.host) ??
              '127.0.0.1',
            port: asPortNumber(env.NEXUS_HTTP_PORT) ?? validatePortNumber(fileConfig.http?.port),
            maxTopK:
              asBoundedPositiveInt(env.NEXUS_HTTP_MAX_TOP_K, 4096) ??
              validateBoundedPositiveInt(fileConfig.http?.maxTopK, 4096) ??
              100,
            maxResultsLimit:
              asBoundedPositiveInt(env.NEXUS_HTTP_MAX_RESULTS_LIMIT, 65536) ??
              validateBoundedPositiveInt(fileConfig.http?.maxResultsLimit, 65536) ??
              1000,
          },
        }
      : {}),
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
    lsp: lspResult.lsp,
  };

  assertEmbeddingApiKeyTransport(merged.embedding);

  if (options.transportMode === 'v2-http') {
    await assertHttpV2Constraints(merged);
  }

  const withLsp: Config = lspResult.error === undefined ? merged : { ...merged, lspConfigError: lspResult.error };
  return projectName === undefined ? withLsp : { ...withLsp, projectName };
};

type LspResolution = { lsp: LspConfig; error?: 'LSP_CONFIG_INVALID' };

const LSP_INVALID = Symbol('lsp-invalid');
type Parsed<T> = T | undefined | typeof LSP_INVALID;

const lspEnvBoolean = (raw: string | undefined): Parsed<boolean> => {
  if (raw === undefined) return undefined;
  return raw === 'true' ? true : raw === 'false' ? false : LSP_INVALID;
};
const lspFileBoolean = (value: unknown): Parsed<boolean> =>
  value === undefined ? undefined : typeof value === 'boolean' ? value : LSP_INVALID;

const lspBoundedInt = (value: unknown, min: number, max: number): Parsed<number> => {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : LSP_INVALID;
};
const lspEnvBoundedInt = (raw: string | undefined, min: number, max: number): Parsed<number> => {
  if (raw === undefined) return undefined;
  return /^\d+$/.test(raw) ? lspBoundedInt(Number.parseInt(raw, 10), min, max) : LSP_INVALID;
};

const lspExecutable = (value: unknown): Parsed<string> => {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' && path.isAbsolute(value) ? value : LSP_INVALID;
};

const lspArgs = (value: unknown): Parsed<string[]> => {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? [...value] : LSP_INVALID;
};
const lspEnvArgs = (raw: string | undefined): Parsed<string[]> => {
  if (raw === undefined) return undefined;
  try {
    return lspArgs(JSON.parse(raw) as unknown);
  } catch {
    return LSP_INVALID;
  }
};

/** Per-field precedence env > file > defaults. Any invalid supplied value invalidates LSP only. */
const resolveLspConfig = (env: NodeJS.ProcessEnv, fileLsp: unknown): LspResolution => {
  const fallback: LspResolution = {
    lsp: { ...DEFAULT_LSP, typescript: { ...DEFAULT_LSP.typescript, args: [...DEFAULT_LSP.typescript.args] } },
    error: 'LSP_CONFIG_INVALID',
  };
  if (fileLsp !== undefined && (fileLsp === null || typeof fileLsp !== 'object' || Array.isArray(fileLsp))) return fallback;
  const file = (fileLsp ?? {}) as Record<string, unknown>;
  const fileTs = file.typescript;
  if (fileTs !== undefined && (fileTs === null || typeof fileTs !== 'object' || Array.isArray(fileTs))) return fallback;
  const ts = (fileTs ?? {}) as Record<string, unknown>;

  const pick = <T>(envValue: Parsed<T>, fileValue: Parsed<T>, dflt: T): T | typeof LSP_INVALID => {
    if (envValue === LSP_INVALID || fileValue === LSP_INVALID) return LSP_INVALID;
    return envValue ?? fileValue ?? dflt;
  };

  const enabled = pick(lspEnvBoolean(env.NEXUS_LSP_ENABLED), lspFileBoolean(file.enabled), DEFAULT_LSP.enabled);
  const executable = pick<string | null>(
    lspExecutable(env.NEXUS_LSP_TYPESCRIPT_EXECUTABLE),
    lspExecutable(ts.executable),
    null,
  );
  const args = pick(lspEnvArgs(env.NEXUS_LSP_TYPESCRIPT_ARGS_JSON), lspArgs(ts.args), [...DEFAULT_LSP.typescript.args]);
  const startupTimeoutMs = pick(
    lspEnvBoundedInt(env.NEXUS_LSP_STARTUP_TIMEOUT_MS, 1, 60_000),
    lspBoundedInt(file.startupTimeoutMs, 1, 60_000),
    DEFAULT_LSP.startupTimeoutMs,
  );
  const requestTimeoutMs = pick(
    lspEnvBoundedInt(env.NEXUS_LSP_REQUEST_TIMEOUT_MS, 1, 60_000),
    lspBoundedInt(file.requestTimeoutMs, 1, 60_000),
    DEFAULT_LSP.requestTimeoutMs,
  );
  const idleTimeoutMs = pick(
    lspEnvBoundedInt(env.NEXUS_LSP_IDLE_TIMEOUT_MS, 1000, 3_600_000),
    lspBoundedInt(file.idleTimeoutMs, 1000, 3_600_000),
    DEFAULT_LSP.idleTimeoutMs,
  );

  if (
    enabled === LSP_INVALID ||
    executable === LSP_INVALID ||
    args === LSP_INVALID ||
    startupTimeoutMs === LSP_INVALID ||
    requestTimeoutMs === LSP_INVALID ||
    idleTimeoutMs === LSP_INVALID
  ) {
    return fallback;
  }
  return { lsp: { enabled, typescript: { executable, args }, startupTimeoutMs, requestTimeoutMs, idleTimeoutMs } };
};

/**
 * True when the host string names a loopback interface.
 * Accepts 127.0.0.0/8 dotted quads, "localhost", and "::1" (brackets optional).
 */
export const isLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHost(host);
  if (normalized === 'localhost' || isLoopbackIpAddress(normalized)) {
    return true;
  }
  return false;
};

const isLoopbackIpAddress = (host: string): boolean => {
  const normalized = normalizeHost(host);
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackIpAddress(normalized.slice('::ffff:'.length));
  }
  const octets = normalized.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return octets !== null && octets.slice(1).every((octet) => Number.parseInt(octet, 10) <= 255);
};

export const resolveLoopbackHost = async (host: string, description = 'host'): Promise<string> => {
  const normalized = normalizeHost(host);
  if (isLoopbackIpAddress(normalized)) {
    return normalized;
  }
  if (isIP(normalized) !== 0 || /^\d+(?:\.\d+){3}$/.test(normalized)) {
    throw new Error(`${description} must resolve only to loopback addresses, but received "${host}".`);
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new Error(`${description} must resolve only to loopback addresses, but "${host}" could not be resolved.`);
  }

  const resolvedAddress = addresses[0]?.address;
  if (resolvedAddress === undefined || !addresses.every(({ address }) => isLoopbackIpAddress(address))) {
    throw new Error(`${description} must resolve only to loopback addresses, but received "${host}".`);
  }

  return resolvedAddress;
};

export const assertLoopbackHost = async (host: string, description = 'host'): Promise<void> => {
  await resolveLoopbackHost(host, description);
};

const normalizeHost = (host: string): string => host.trim().toLowerCase().replace(/^\[|\]$/g, '');

function assertEmbeddingApiKeyTransport(embedding: EmbeddingConfig): void {
  if (embedding.apiKey === undefined) {
    return;
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(embedding.baseUrl ?? '');
  } catch {
    throw new Error('embedding.baseUrl must use https when embedding.apiKey is configured.');
  }

  if (parsedBaseUrl.protocol !== 'https:') {
    throw new Error('embedding.baseUrl must use https when embedding.apiKey is configured.');
  }
}

/**
 * Local HTTP v2 constraints (design doc §3.2 / §6.1). Runs only when the
 * config was loaded with transportMode="v2-http":
 * - host must be a loopback interface (fail-closed; --allow-network is Phase 3)
 * - external embedding providers are rejected (local-first contract)
 */
export async function assertHttpV2Constraints(config: Config): Promise<void> {
  if (config.http === undefined) {
    throw new Error('Local HTTP v2 requires the http config block (transportMode="v2-http").');
  }
  try {
    await assertLoopbackHost(config.http.host, 'Local HTTP v2 host');
  } catch {
    throw new Error(
      `Local HTTP v2 can only bind to a loopback interface (127.0.0.1, localhost, or ::1), ` +
        `but received "${config.http.host}".`,
    );
  }
  if (config.embedding.provider === 'openai-compat' || config.embedding.provider === 'bedrock') {
    throw new Error(
      `Local HTTP v2 is local-only: embedding.provider "${config.embedding.provider}" contacts ` +
        'external networks. Use "ollama" or "test".',
    );
  }
  if (config.embedding.provider === 'ollama') {
    const parsedBaseUrl = parseOllamaBaseUrl(config.embedding.baseUrl);
    if (parsedBaseUrl === null || (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:')) {
      throw new Error('Local HTTP v2 requires the Ollama embedding base URL to use a loopback interface, but received an invalid URL.');
    }
    try {
      await assertLoopbackHost(parsedBaseUrl.hostname, 'Ollama embedding host');
    } catch {
      throw new Error(
        `Local HTTP v2 requires the Ollama embedding base URL to use a loopback interface, ` +
          `but received hostname "${parsedBaseUrl.hostname || '(empty)'}".`,
      );
    }
  }
}

const parseOllamaBaseUrl = (baseUrl: string | undefined): URL | null => {
  if (baseUrl === undefined) {
    return null;
  }
  try {
    return new URL(baseUrl);
  } catch {
    return null;
  }
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

const asJsonRecord = (value: string | undefined): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return validateHeaders(parsed);
  } catch {
    return undefined;
  }
};

const validateHeaders = (value: unknown): Record<string, string> | undefined => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.every(([k, v]) => typeof k === 'string' && typeof v === 'string')) {
      try {
        new Headers(entries);
        return Object.fromEntries(entries);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
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

    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
};

import type { StructuredLanguageParser } from '../structured/contracts.js';

export type SymbolKind =
  | 'file'
  | 'module'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'typeAlias'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'variable'
  | 'constant'
  | 'constructor'
  | 'import'
  | 'comment'
  | 'unknown'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'record'
  | 'field';

export interface CodeChunk {
  id: string;
  filePath: string;
  content: string;
  language: string;
  symbolName?: string;
  symbolKind: SymbolKind;
  startLine: number;
  endLine: number;
  hash: string;
  symbolId?: string;
  generationId?: string;
}

export interface SearchResult {
  chunk: CodeChunk;
  score: number;
  source: 'semantic' | 'grep' | 'hybrid';
}

export interface RankedResult extends SearchResult {
  rank: number;
  reciprocalRankScore: number;
  snippet?: string;
  snippetStartLine?: number;
  snippetEndLine?: number;
}

export interface SearchResponse {
  query: string;
  results: RankedResult[];
  tookMs: number;
}

export type IndexEventType = 'added' | 'modified' | 'deleted';

export interface IndexEvent {
  type: IndexEventType;
  filePath: string;
  contentHash?: string;
  detectedAt: string;
}

export interface FileToChunk {
  filePath: string;
  language: string;
  content: string;
  bytes?: Uint8Array;
}

export interface ParsedDeclaration {
  type: SymbolKind;
  name: string;
  symbolId?: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ParsedSourceFile {
  rootType: string;
  declarations: ParsedDeclaration[];
}

export type {
  IMetadataStore,
  StructuredCapableMetadataStore,
  MerkleNodeRow,
  IndexStatsRow,
  EmbeddingCacheEntry,
} from '../storage/interfaces/metadata-store.js';
export { supportsStructuredCatalog } from '../storage/interfaces/metadata-store.js';
export type {
  ActiveGeneration,
  ChunkWithEmbedding,
  CompactionConfig,
  CompactionMutex,
  CompactionResult,
  GenerationChunkBatch,
  IVectorStore,
  LegacyShadowDeletion,
  LegacyShadowTable,
  StructuredRowVisibility,
  StructuredShadowTable,
  VectorFilter,
  VectorSearchResult,
  VectorStoreStats,
} from '../storage/interfaces/vector-store.js';

export interface GrepParams {
  query: string;
  cwd: string;
  glob?: string[];
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
  abortSignal?: AbortSignal;
}

export interface GrepMatch {
  filePath: string;
  lineNumber: number;
  lineText: string;
  submatches: Array<{
    start: number;
    end: number;
    match: string;
  }>;
}

export interface IGrepEngine {
  search(params: GrepParams): Promise<GrepMatch[]>;
}

export interface EmbeddingConfig {
  provider: 'ollama' | 'openai-compat' | 'bedrock' | 'test';
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  region?: string;
  profile?: string;
  headers?: Record<string, string>;
  maxConcurrency: number;
  batchSize: number;
  retryCount: number;
  retryBaseDelayMs: number;
  timeoutMs?: number;
  ollamaNumThread?: number;
  ollamaLockTimeoutMs?: number;
}

/** Ollama provider requires the thread-count option. */
export type OllamaEmbeddingConfig = EmbeddingConfig & { ollamaNumThread: number };

export interface EmbeddingProvider {
  readonly dimensions: number;
  /**
   * Embed a batch of texts into vectors.
   *
   * Implementations MUST throw {@link RetryExhaustedError} when all retry
   * attempts are exhausted so that the caller (IndexPipeline) can route the
   * failed file to the Dead Letter Queue for later recovery.
   *
   * Other fatal errors (e.g. {@link DimensionMismatchError}) may be thrown
   * directly and will propagate as unrecoverable failures.
   */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}

export interface LanguagePlugin {
  readonly languageId: string;
  readonly fileExtensions: string[];
  supports(filePath: string): boolean;
  createParser(): Promise<{
    parse(file: FileToChunk): Promise<ParsedSourceFile>;
  }>;
  createStructuredParser?: () => Promise<StructuredLanguageParser>;
}

export interface WatcherConfig {
  debounceMs: number;
  maxQueueSize: number;
  fullScanThreshold: number;
  ignorePaths?: string[];
}

export interface FileWatcherOptions {
  projectRoot: string;
  ignorePaths?: string[];
  onFullScanRequired?: () => Promise<void>;
}

export interface IFileWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface StorageConfig {
  rootDir: string;
  metadataDbPath: string;
  vectorDbPath: string;
  batchSize?: number;
}

export interface IndexingConfig {
  maxFileBytes: number;
  /** Maximum characters per chunk before splitting. 0 = unlimited. Default: 6000. */
  maxChunkChars: number;
  /** Number of files read & chunked concurrently in stage 1 of the indexing pipeline. Default: 2. */
  chunkConcurrency: number;
  /** Number of files whose chunks are aggregated into a single cross-file embed() batch. Default: 16. */
  embedBatchWindowSize: number;
}

/** Local HTTP v2 (`nexus serve`) settings. Present only in v2-http transport mode. */
export interface HttpConfig {
  host: string;
  port?: number | undefined;
  /** v2 経路の topK 上限（設計書 §10.3、既定 100）。 */
  maxTopK: number;
  /** v2 経路の maxResults 上限（設計書 §10.3、既定 1000）。 */
  maxResultsLimit: number;
}

export interface Config {
  projectRoot: string;
  projectName?: string;
  storage: StorageConfig;
  watcher: WatcherConfig;
  embedding: EmbeddingConfig;
  indexing: IndexingConfig;
  /** Present only when the config was loaded with transportMode="v2-http". */
  http?: HttpConfig | undefined;
  metricsPort?: number;
  aggregatorPort?: number;
  packageMode: boolean;
}

export interface DeadLetterEntry {
  id: string;
  filePath: string;
  contentHash: string;
  errorMessage: string;
  attempts: number;
  recoveryAttempts: number;
  createdAt: string;
  updatedAt: string;
  lastRetryAt: string | null;
}

export class DimensionMismatchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DimensionMismatchError';
  }
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;

  constructor(message: string, attempts: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
  }
}

/** Thrown for embedding errors that must not be retried (e.g. HTTP 400 context-length exceeded). */
export class NonRetryableEmbeddingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NonRetryableEmbeddingError';
  }
}

export class PathTraversalError extends Error {
  readonly attemptedPath: string;

  constructor(attemptedPath: string, options?: ErrorOptions) {
    super(`Path traversal detected: ${attemptedPath}`, options);
    this.name = 'PathTraversalError';
    this.attemptedPath = attemptedPath;
  }
}

export interface ReconciliationResult {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
}

export interface RuntimeInitializationResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  reconciliation: ReconciliationResult;
  chunksIndexed: number;
}

export interface ReindexOptions {
  fullScan?: boolean;
  pathPrefix?: string;
  reason?: 'manual' | 'overflow-recovery' | 'startup-reconciliation';
}

export interface ReindexQueueEvent {
  type: 'reindex';
  priority: 'high';
  options: ReindexOptions;
  detectedAt: string;
}

export interface ReindexResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  reconciliation: ReconciliationResult;
  chunksIndexed: number;
}

export interface PipelineProgress {
  totalFiles: number;
  processedFiles: number;
  currentFile?: string;
  status: 'idle' | 'running' | 'stopping';
  lastError?: string;
}

export interface IIndexPipeline {
  start(): void;
  stop(): Promise<void>;
  reindex(
    run: (options?: { fullScan?: boolean; reason?: ReindexOptions['reason'] }) => Promise<IndexEvent[]>,
    loadContent: (filePath: string) => Promise<string>,
    fullRebuild?: boolean,
    reason?: ReindexOptions['reason'],
  ): Promise<ReindexResult | { status: 'already_running' } | { status: 'incomplete' }>;
  waitForActiveReindex(): Promise<void>;
  getSkippedFiles(): ReadonlyMap<string, string>;
  reconcileOnStartup(): Promise<RuntimeInitializationResult>;
  getProgress(): PipelineProgress;
}

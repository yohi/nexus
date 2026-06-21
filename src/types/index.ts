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
  | 'unknown';

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
}

export interface SearchResult {
  chunk: CodeChunk;
  score: number;
  source: 'semantic' | 'grep' | 'hybrid';
}

export interface RankedResult extends SearchResult {
  rank: number;
  reciprocalRankScore: number;
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
}

export interface ParsedDeclaration {
  type: SymbolKind;
  name: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ParsedSourceFile {
  rootType: string;
  declarations: ParsedDeclaration[];
}

export interface VectorFilter {
  filePathPrefix?: string;
  language?: string;
  symbolKind?: SymbolKind;
}

export interface VectorSearchResult {
  chunk: CodeChunk;
  score: number;
}

export interface VectorStoreStats {
  totalChunks: number;
  totalFiles: number;
  dimensions: number;
  fragmentationRatio: number;
  lastCompactedAt?: string;
}

export interface CompactionResult {
  compacted: boolean;
  fragmentationRatioBefore: number;
  fragmentationRatioAfter: number;
  chunksRemoved: number;
}

export interface CompactionConfig {
  fragmentationThreshold: number;
  minStaleChunks: number;
  idleDelayMs: number;
}

export interface CompactionMutex {
  waitForUnlock(abortSignal?: AbortSignal): Promise<void>;
}

export interface IVectorStore {
  initialize(): Promise<void>;
  upsertChunks(chunks: CodeChunk[], embeddings?: number[][], affectedFilePaths?: string[]): Promise<void>;
  deleteByFilePath(filePath: string): Promise<number>;
  deleteByPathPrefix(pathPrefix: string): Promise<number>;
  renameFilePath(oldPath: string, newPath: string): Promise<number>;
  search(queryVector: number[], topK: number, filter?: VectorFilter): Promise<VectorSearchResult[]>;
  compactIfNeeded(config?: Partial<CompactionConfig>): Promise<CompactionResult>;
  compactAfterReindex(config?: Partial<CompactionConfig>): Promise<CompactionResult>;
  scheduleIdleCompaction(
    runCompaction: () => Promise<void>,
    delayMs?: number,
    mutex?: CompactionMutex,
    abortSignal?: AbortSignal,
    mutexTimeoutMs?: number,
  ): NodeJS.Timeout;
  getStats(): Promise<VectorStoreStats>;
  close(timeoutMs?: number): Promise<void>;
}

export interface MerkleNodeRow {
  path: string;
  hash: string;
  parentPath: string | null;
  isDirectory: boolean;
}

export interface IndexStatsRow {
  id: 'primary';
  totalFiles: number;
  totalChunks: number;
  lastIndexedAt: string | null;
  lastFullScanAt: string | null;
  overflowCount: number;
}

export interface EmbeddingCacheEntry {
  hash: string;
  vector: number[];
}


export interface IMetadataStore {
  initialize(): Promise<void>;
  bulkUpsertMerkleNodes(nodes: MerkleNodeRow[]): Promise<void>;
  bulkDeleteMerkleNodes(paths: string[]): Promise<void>;
  bulkDeleteSubtrees(paths: string[]): Promise<number>;
  deleteSubtree(pathPrefix: string): Promise<number>;
  getSubtreePaths(pathPrefix: string): Promise<string[]>;
  pruneEmptyParents(path: string, pathExists: (targetPath: string) => Promise<boolean>): Promise<void>;
  renamePath(oldPath: string, newPath: string, hash: string): Promise<void>;
  getMerkleNode(path: string): Promise<MerkleNodeRow | null>;
  getChildren(path: string | null): Promise<MerkleNodeRow[]>;
  hasChildren(path: string | null): Promise<boolean>;
  getAllNodes(): Promise<MerkleNodeRow[]>;
  getAllFileNodes(): Promise<MerkleNodeRow[]>;
  getAllPaths(): Promise<string[]>;
  getIndexStats(): Promise<IndexStatsRow | null>;
  setIndexStats(stats: IndexStatsRow): Promise<void>;
  upsertDeadLetterEntries(entries: DeadLetterEntry[]): Promise<void>;
  removeDeadLetterEntries(ids: string[]): Promise<void>;
  getDeadLetterEntries(): Promise<DeadLetterEntry[]>;
  getEmbeddings(hashes: string[]): Promise<Map<string, number[]>>;
  setEmbeddings(entries: EmbeddingCacheEntry[]): Promise<void>;
  deleteEmbeddings(hashes: string[]): Promise<void>;
  clearEmbeddings(): Promise<void>;
  pruneEmbeddings(maxAgeDays: number): Promise<number>;

}

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
  provider: 'ollama' | 'openai-compat' | 'test';
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  maxConcurrency: number;
  batchSize: number;
  retryCount: number;
  retryBaseDelayMs: number;
  timeoutMs?: number;
  ollamaNumThread?: number;
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
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}

export interface LanguagePlugin {
  readonly languageId: string;
  readonly fileExtensions: string[];
  supports(filePath: string): boolean;
  createParser(): Promise<{
    parse(file: FileToChunk): Promise<ParsedSourceFile>;
  }>;
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

export interface Config {
  projectRoot: string;
  projectName?: string;
  storage: StorageConfig;
  watcher: WatcherConfig;
  embedding: EmbeddingConfig;
  indexing: IndexingConfig;
  metricsPort?: number;
  aggregatorPort?: number;
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
    run: (options?: { fullScan?: boolean; reason?: 'manual' }) => Promise<IndexEvent[]>,
    loadContent: (filePath: string) => Promise<string>,
    fullRebuild?: boolean,
  ): Promise<ReindexResult | { status: 'already_running' }>;
  getSkippedFiles(): ReadonlyMap<string, string>;
  reconcileOnStartup(): Promise<RuntimeInitializationResult>;
  getProgress(): PipelineProgress;
}

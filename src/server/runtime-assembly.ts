import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import picomatch from 'picomatch';
import { normalizeIgnorePaths } from '../utils/path-normalization.js';
import { acquireProjectLock } from '../utils/project-lock.js';
import { buildNexusRuntime } from './index.js';
import type { NexusRuntimeOptions } from './index.js';
import { PathSanitizer } from './path-sanitizer.js';
import { SemanticSearch } from '../search/semantic.js';
import { SearchOrchestrator } from '../search/orchestrator.js';
import { IndexPipeline } from '../indexer/pipeline.js';
import { Chunker } from '../indexer/chunker.js';
import { InstrumentedEmbeddingProvider } from '../plugins/embeddings/instrumented.js';
import { resolveLocalOllamaBaseUrl } from '../plugins/embeddings/ollama.js';
import { LocalContentStoreFactory } from '../storage/local/local-content-store.js';
import { MetricsCollector } from '../observability/metrics-collector.js';
import { SymbolRetrievalService } from '../structured/retrieval-service.js';
import { StructuredIndexCoordinator } from '../indexer/structured-index-coordinator.js';
import { ProjectWriteCoordinator } from '../indexer/project-write-coordinator.js';
import { RuntimeLocalLspManager } from '../lsp/process-manager.js';
import { LspNavigationService, lspNavigationLockTimeoutMs } from '../lsp/navigation-service.js';
import { defaultLspConfig } from '../config/index.js';
import type { Config } from '../types/index.js';
import type { RuntimeAssembly, RuntimeAssemblyDependencies } from './runtime/assembly-types.js';
import { DirectoryScanner } from './runtime/directory-scan.js';
import { StorageManager } from './runtime/storage.js';
import { setupPluginRegistry } from './runtime/plugins.js';
import { createGrepEngine } from './runtime/grep-spawn.js';
import { createRuntimeLogging } from './runtime/logging.js';
import { EventProcessingManager } from './runtime/events.js';
import { runtimeStateRevision } from '../observability/runtime-observer.js';
import { runRuntimeDiagnosticStage, withRuntimeDiagnosticContext, withoutRuntimeDiagnosticContext } from '../observability/diagnostic-stage-trace.js';
import {
  StorageOwnershipError, storageOwnershipAdmissionService, type ConsumedWriterLease, type WriterAdmission,
} from './storage-ownership/admission.js';
import { getWriterLeaseLostHandler } from './runtime/writer-lease-loss.js';

/** Bounded detection window for a lost kernel writer lease while the runtime serves. */
const DEFAULT_WRITER_LEASE_CHECK_INTERVAL_MS = 5_000;

/**
 * Nexus #297 (F-003): obtain the runtime's single writer lease before ANY ordinary Storage mutation. A transferred
 * handle is authenticated and consumed exactly once; without a handle the Assembly performs its own admission.
 */
async function acquireRuntimeWriterLease(config: Config, handle: WriterAdmission | undefined): Promise<ConsumedWriterLease> {
  const service = storageOwnershipAdmissionService;
  if (handle !== undefined) return await service.consumeWriterAdmission(handle, config);
  const own = await service.admitStorageWriter(await service.resolveStorageOwnershipTargets(config));
  try { return await service.consumeWriterAdmission(own, config); }
  catch (error) { await own.release(); throw error; }
}

async function closeResources(steps: readonly (() => Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const close of steps) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Runtime resource cleanup failed');
}

export async function createRuntimeAssembly(config: Config,
  dependencies: RuntimeAssemblyDependencies = {}): Promise<RuntimeAssembly> {
  const diagnosticContext = dependencies.diagnosticTraceContext;
  if (diagnosticContext === undefined) return await createRuntimeAssemblyCore(config, dependencies);
  return await withRuntimeDiagnosticContext(diagnosticContext, async () =>
    await runRuntimeDiagnosticStage('S03_runtime_assembly', async () => await createRuntimeAssemblyCore(config, dependencies)));
}

async function createRuntimeAssemblyCore(config: Config,
  dependencies: RuntimeAssemblyDependencies = {}): Promise<RuntimeAssembly> {
  const { projectRoot } = config;
  const writerLease = await acquireRuntimeWriterLease(config, dependencies.writerAdmission);
  let projectLock;
  try {
    await StorageManager.ensureDirectories(config);
    try { projectLock = await acquireProjectLock(config.storage.rootDir); }
    catch (lockError) {
      console.error('[Nexus] Failed to acquire project lock:', lockError);
      throw lockError;
    }
  } catch (error) {
    await writerLease.release();
    throw error;
  }
  let leaseMonitor: NodeJS.Timeout | undefined;
  const stopLeaseMonitor = (): Promise<void> => { clearInterval(leaseMonitor); return Promise.resolve(); };
  let stores: Awaited<ReturnType<typeof StorageManager.initializeStores>> | undefined;
  let logging: ReturnType<typeof createRuntimeLogging> | undefined;
  let stopEvents: (() => Promise<void>) | undefined;
  let lspManager: RuntimeLocalLspManager | undefined;
  try {
    const { metadataStore, vectorStore } = await StorageManager.initializeStores(config);
    stores = { metadataStore, vectorStore };
    const pluginConfig = config.http !== undefined && config.embedding.provider === 'ollama'
      ? { ...config, embedding: { ...config.embedding,
        baseUrl: await resolveLocalOllamaBaseUrl(config.embedding.baseUrl) } } : config;
    const pluginRegistry = setupPluginRegistry(pluginConfig, dependencies.createEmbeddingProvider);
    const metricsCollector = new MetricsCollector({ projectName: config.projectName || basename(projectRoot) });
    const provider = pluginRegistry.getEmbeddingProvider();
    if (!provider) throw new Error('No embedding provider configured.');
    const embeddingProvider = new InstrumentedEmbeddingProvider(provider, metricsCollector, config.embedding.provider);
    const runtimeLogging = createRuntimeLogging(config.storage.rootDir);
    logging = runtimeLogging;
    const { onLog } = runtimeLogging;
    const semanticSearch = new SemanticSearch({
      vectorStore, embeddingProvider, observer: dependencies.observer,
      activeGenerationResolver: {
        resolveActiveGenerations: async (filePaths) => await metadataStore.getActiveGenerationMap(filePaths),
      },
    });
    const grepEngine = createGrepEngine(projectRoot, dependencies.observer);
    const orchestrator = new SearchOrchestrator({ semanticSearch, grepEngine, projectRoot, observer: dependencies.observer });
    const structuredIndexCoordinator = new StructuredIndexCoordinator({
      metadataStore, vectorStore,
      chunker: new Chunker(pluginRegistry, { maxChunkChars: config.indexing.maxChunkChars }),
      projectWriteCoordinator: new ProjectWriteCoordinator(),
      config: { embedding: { dimensions: config.embedding.dimensions } },
    });
    const loadFileBytes = (filePath: string) => readFile(resolve(projectRoot, filePath));
    const loadFileContent = (filePath: string) => readFile(resolve(projectRoot, filePath), 'utf8');
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker: new Chunker(pluginRegistry, { maxChunkChars: config.indexing.maxChunkChars }),
      embeddingProvider, embeddingConfig: pluginConfig.embedding, pluginRegistry,
      structuredIndexCoordinator, loadFileBytes, maxFileBytes: config.indexing.maxFileBytes,
      chunkConcurrency: config.indexing.chunkConcurrency, embedBatchWindowSize: config.indexing.embedBatchWindowSize,
      onProgress: (msg) => onLog(msg), metricsHooks: metricsCollector,
      observer: dependencies.observer,
    });
    const ignorePaths = config.watcher.ignorePaths ?? [];
    const eventManager = new EventProcessingManager(config, projectRoot, ignorePaths, pipeline,
      loadFileContent, onLog, metricsCollector, dependencies.observer);
    const { eventQueue, watcher, onClose } = dependencies.diagnosticTraceContext === undefined
      ? eventManager.setup()
      : withoutRuntimeDiagnosticContext(() => eventManager.setup());
    stopEvents = onClose;
    const sanitizer = await PathSanitizer.create(projectRoot);
    const workspaceId = config.projectName ?? projectRoot.split(/[\\/]/).findLast(Boolean) ?? 'unknown';
    const contentStore = new LocalContentStoreFactory({
      projectRoot, sanitize: (filePath) => sanitizer.resolveExisting(filePath),
    }).getStore(workspaceId, 'local');
    const symbolIgnoreMatcher = picomatch(normalizeIgnorePaths(ignorePaths), { windows: true });
    const symbolRetrievalService = new SymbolRetrievalService({
      catalog: metadataStore, sanitizer, isExcluded: (filePath) => symbolIgnoreMatcher(filePath),
    });
    // Runtime-local LSP: lazy (no process until the first navigation), Owner approval is
    // re-resolved by the manager on every new launch, and failures stay LSP-local.
    const canonicalRoot = sanitizer.getProjectRoot();
    // A Config built without loadConfig may omit `lsp`; fall back to the disabled default.
    const lsp = config.lsp ?? defaultLspConfig();
    const manager = new RuntimeLocalLspManager({
      projectRoot: canonicalRoot, lsp,
      ...(config.lspConfigError === undefined ? {} : { configError: config.lspConfigError }),
    });
    lspManager = manager;
    const lspNavigationService = new LspNavigationService({
      projectRoot: canonicalRoot, sanitizer, symbols: symbolRetrievalService,
      isExcluded: (filePath) => symbolIgnoreMatcher(filePath),
      acquireProvider: (input) => manager.acquire(input),
      lockTimeoutMs: lspNavigationLockTimeoutMs(lsp),
    });
    let closePromise: Promise<void> | undefined;
    const runReindex = () => DirectoryScanner.scan(projectRoot, projectRoot, ignorePaths, onLog);
    const options: NexusRuntimeOptions = {
      projectRoot, sanitizer, semanticSearch, grepEngine, orchestrator, vectorStore,
      metadataStore, pipeline, eventQueue, pluginRegistry, watcher, loadFileContent,
      contentStore, symbolRetrievalService, lspNavigationService, metricsCollectorRegistry: metricsCollector.registry,
      metricsPort: config.metricsPort, storageDir: config.storage.rootDir, projectName: config.projectName,
      metricsHooks: metricsCollector, aggregatorPort: config.aggregatorPort, packageMode: config.packageMode,
      // The writer lease is released last, after every store and the project lock are closed.
      onClose: () => closePromise ??= closeResources([
        stopLeaseMonitor, () => manager.close(), onClose, () => vectorStore.close(), () => metadataStore.close(),
        () => runtimeLogging.close(), () => projectLock.release(), () => writerLease.release(),
      ]),
      runReindex,
    };
    const runtime = buildNexusRuntime(options);
    // Fail closed on a lost lease (Nexus #297). No graceful runtime.close(): that would await in-flight startup
    // reconcile/reindex writes and remove the metrics-port file, i.e. keep mutating storage after the loss.
    // 1. synchronously abort the pipeline (IndexPipeline.stop() aborts before its first await);
    // 2. hand over to the process-level fail-fast handler (CLI/serve exit non-zero; the kernel drops the leases);
    // 3. quiesce watcher/event processing and leave stores untouched while fail-fast handling proceeds.
    const onWriterLeaseLost = (): void => {
      clearInterval(leaseMonitor);
      runtime.terminate?.();
      pipeline.stop().catch(() => undefined);
      const lost = new StorageOwnershipError('invalid_writer_admission', 'storage writer lease was lost while serving');
      console.error('[Nexus] Storage writer lease was lost; stopping all storage mutation (fail-closed).');
      watcher.stop().catch(() => undefined);
      onClose().catch(() => undefined);
      const handler = dependencies.onWriterLeaseLost ?? getWriterLeaseLostHandler();
      if (handler !== undefined) { handler(lost); return; }
    };
    leaseMonitor = setInterval(() => {
      if (!writerLease.isHeld()) onWriterLeaseLost();
    }, dependencies.writerLeaseCheckIntervalMs ?? DEFAULT_WRITER_LEASE_CHECK_INTERVAL_MS);
    leaseMonitor.unref();
    const initializationContext = dependencies.diagnosticTraceContext;
    if (initializationContext !== undefined) {
      const initialize = runtime.initialize.bind(runtime);
      runtime.initialize = () => withRuntimeDiagnosticContext(initializationContext,
        async () => await runRuntimeDiagnosticStage('S04_runtime_initialization', initialize));
    }
    return {
      runtime, options,
      diagnostics: {
        metadataStore, vectorStore, metadataDbPath: config.storage.metadataDbPath, vectorDbPath: config.storage.vectorDbPath, sanitizer,
        queueSnapshot: () => ({ size: eventQueue.size(), postScanSize: eventQueue.getPostScanQueueSize(),
          dropped: eventQueue.getDroppedEventCount(), state: eventQueue.getState(), postScanActive: eventQueue.isPostScanActive() }),
        pendingDrainCount: () => eventManager.getPendingDrainCount(),
        stateRevision: () => runtimeStateRevision(dependencies.observer),
      },
    };
  } catch (error) {
    try {
      await closeResources([
        () => lspManager?.close() ?? Promise.resolve(),
        () => stopEvents?.() ?? Promise.resolve(),
        () => stores?.metadataStore.close() ?? Promise.resolve(),
        () => stores?.vectorStore.close() ?? Promise.resolve(),
        () => logging?.close() ?? Promise.resolve(),
        () => projectLock.release(),
        stopLeaseMonitor,
        () => writerLease.release(),
      ]);
    } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Runtime construction and cleanup failed'); }
    throw error;
  }
}

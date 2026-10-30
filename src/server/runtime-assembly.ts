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
  await StorageManager.ensureDirectories(config);
  let projectLock;
  try { projectLock = await acquireProjectLock(config.storage.rootDir); }
  catch (lockError) {
    console.error('[Nexus] Failed to acquire project lock:', lockError);
    throw lockError;
  }
  let stores: Awaited<ReturnType<typeof StorageManager.initializeStores>> | undefined;
  let logging: ReturnType<typeof createRuntimeLogging> | undefined;
  let stopEvents: (() => Promise<void>) | undefined;
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
    let closePromise: Promise<void> | undefined;
    const runReindex = () => DirectoryScanner.scan(projectRoot, projectRoot, ignorePaths, onLog);
    const options: NexusRuntimeOptions = {
      projectRoot, sanitizer, semanticSearch, grepEngine, orchestrator, vectorStore,
      metadataStore, pipeline, eventQueue, pluginRegistry, watcher, loadFileContent,
      contentStore, symbolRetrievalService, metricsCollectorRegistry: metricsCollector.registry,
      metricsPort: config.metricsPort, storageDir: config.storage.rootDir, projectName: config.projectName,
      metricsHooks: metricsCollector, aggregatorPort: config.aggregatorPort, packageMode: config.packageMode,
      onClose: () => closePromise ??= closeResources([
        onClose, () => vectorStore.close(), () => metadataStore.close(),
        () => runtimeLogging.close(), () => projectLock.release(),
      ]),
      runReindex,
    };
    const runtime = buildNexusRuntime(options);
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
        () => stopEvents?.() ?? Promise.resolve(),
        () => stores?.metadataStore.close() ?? Promise.resolve(),
        () => stores?.vectorStore.close() ?? Promise.resolve(),
        () => logging?.close() ?? Promise.resolve(),
        () => projectLock.release(),
      ]);
    } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Runtime construction and cleanup failed'); }
    throw error;
  }
}

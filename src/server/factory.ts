import { spawn } from 'node:child_process';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep, resolve } from 'node:path';

import { initializeNexusRuntime, type NexusRuntime } from './index.js';
import { PathSanitizer } from './path-sanitizer.js';
import { SemanticSearch } from '../search/semantic.js';
import { SearchOrchestrator } from '../search/orchestrator.js';
import { PluginRegistry } from '../plugins/registry.js';
import { IndexPipeline } from '../indexer/pipeline.js';
import { Chunker } from '../indexer/chunker.js';
import { TypeScriptLanguagePlugin } from '../plugins/languages/typescript.js';
import { PythonLanguagePlugin } from '../plugins/languages/python.js';
import { GoLanguagePlugin } from '../plugins/languages/go.js';
import { OllamaEmbeddingProvider } from '../plugins/embeddings/ollama.js';
import { OpenAICompatEmbeddingProvider } from '../plugins/embeddings/openai-compat.js';
import { SqliteMetadataStore } from '../storage/metadata-store.js';
import { LanceVectorStore } from '../storage/vector-store.js';
import { RipgrepEngine } from '../search/grep.js';
import { FileWatcher } from '../indexer/watcher.js';
import { EventQueue } from '../indexer/event-queue.js';
import type { Config, GrepMatch, IndexEvent } from '../types/index.js';

export class NexusServerFactory {
  /**
   * Creates and initializes a NexusRuntime based on the provided configuration.
   * Encapsulates the complexity of assembling dependencies for the MCP server.
   */
  static async createRuntime(config: Config): Promise<NexusRuntime> {
    const { projectRoot } = config;

    await this.ensureStorageDirectories(config);

    const { metadataStore, vectorStore } = this.initializeStores(config);
    const pluginRegistry = this.setupPluginRegistry(config);

    const embeddingProvider = pluginRegistry.getEmbeddingProvider();
    if (!embeddingProvider) {
      throw new Error('No embedding provider configured. Please check your configuration.');
    }

    const semanticSearch = new SemanticSearch({ vectorStore, embeddingProvider });
    const grepEngine = this.createGrepEngine(projectRoot);
    const orchestrator = new SearchOrchestrator({ semanticSearch, grepEngine, projectRoot });
    const chunker = new Chunker(pluginRegistry);

    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider,
      pluginRegistry,
    });

    const loadFileContent = (path: string) => {
      const absolutePath = resolve(projectRoot, path);
      return readFile(absolutePath, 'utf8');
    };

    const ignorePaths = this.getIgnorePaths();
    const { watcher, onClose } = this.setupEventProcessing(config, projectRoot, ignorePaths, pipeline, loadFileContent);

    const sanitizer = await PathSanitizer.create(projectRoot);

    const runtime = await initializeNexusRuntime({
      projectRoot,
      sanitizer,
      semanticSearch,
      grepEngine,
      orchestrator,
      vectorStore,
      metadataStore,
      pipeline,
      pluginRegistry,
      watcher,
      runReindex: async (args) => {
        let scannedEvents: IndexEvent[] = [];
        await pipeline.reindex(
          async () => {
            scannedEvents = await this.scanDirectory(projectRoot, projectRoot, ignorePaths);
            return scannedEvents;
          },
          loadFileContent,
          args?.fullScan,
        );
        return scannedEvents;
      },
      loadFileContent,
      onClose,
    });

    return runtime;
  }

  private static async ensureStorageDirectories(config: Config): Promise<void> {
    await mkdir(resolve(config.storage.rootDir), { recursive: true });
    await mkdir(dirname(resolve(config.storage.metadataDbPath)), { recursive: true });
    if (!config.storage.vectorDbPath.startsWith('memory://')) {
      await mkdir(resolve(config.storage.vectorDbPath), { recursive: true });
    }
  }

  private static initializeStores(config: Config) {
    const metadataStore = new SqliteMetadataStore({
      databasePath: config.storage.metadataDbPath,
      batchSize: config.storage.batchSize,
    });

    const vectorStore = new LanceVectorStore({
      dbPath: config.storage.vectorDbPath,
      dimensions: config.embedding.dimensions,
    });

    return { metadataStore, vectorStore };
  }

  private static setupPluginRegistry(config: Config): PluginRegistry {
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.registerLanguage(new TypeScriptLanguagePlugin());
    pluginRegistry.registerLanguage(new PythonLanguagePlugin());
    pluginRegistry.registerLanguage(new GoLanguagePlugin());

    if (config.embedding.provider === 'ollama') {
      pluginRegistry.registerEmbeddingProvider('ollama', new OllamaEmbeddingProvider(config.embedding));
      pluginRegistry.setActiveEmbeddingProvider('ollama');
    } else if (config.embedding.provider === 'openai-compat') {
      pluginRegistry.registerEmbeddingProvider(
        'openai-compat',
        new OpenAICompatEmbeddingProvider(config.embedding),
      );
      pluginRegistry.setActiveEmbeddingProvider('openai-compat');
    }

    return pluginRegistry;
  }

  private static createGrepEngine(projectRoot: string): RipgrepEngine {
    return new RipgrepEngine({
      projectRoot,
      spawn: async (params, signal) => {
        return new Promise((resolvePromise, reject) => {
          const args = ['--json'];
          if (!params.caseSensitive) args.push('--ignore-case');
          if (params.glob?.length) {
            params.glob.forEach((g) => args.push('--glob', g));
          }
          args.push('--', params.query, params.cwd);

          const child = spawn('rg', args, { signal });
          let stdout = '';
          let stderr = '';

          child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
          child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

          child.on('close', (code) => {
            if (code !== 0 && code !== 1) {
              reject(new Error(`ripgrep failed with code ${code}: ${stderr}`));
              return;
            }
            resolvePromise(this.parseGrepOutput(stdout));
          });

          child.on('error', (err) => {
            if (err.name === 'AbortError') resolvePromise([]);
            else reject(err);
          });
        });
      },
    });
  }

  private static parseGrepOutput(stdout: string): GrepMatch[] {
    const lines = stdout.split('\n').filter((l) => l.trim() !== '');
    const matches: GrepMatch[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'match') {
          matches.push({
            filePath: parsed.data.path.text,
            lineNumber: parsed.data.line_number,
            lineText: parsed.data.lines.text,
            submatches: parsed.data.submatches.map((m: any) => ({
              start: m.start,
              end: m.end,
              match: m.match.text,
            })),
          });
        }
      } catch { /* ignore */ }
    }
    return matches;
  }

  private static async scanDirectory(dir: string, projectRoot: string, ignorePaths: string[]): Promise<IndexEvent[]> {
    const entries = await readdir(resolve(dir), { withFileTypes: true });
    const events: IndexEvent[] = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(projectRoot, fullPath);
      const segments = relPath.split(sep);

      if (ignorePaths.some((p) => segments.includes(p))) continue;

      if (entry.isDirectory()) {
        events.push(...(await this.scanDirectory(fullPath, projectRoot, ignorePaths)));
      } else if (entry.isFile()) {
        events.push({
          type: 'added',
          filePath: relPath,
          detectedAt: new Date().toISOString(),
        });
      }
    }
    return events;
  }

  private static getIgnorePaths(): string[] {
    const envIgnore = process.env.NEXUS_IGNORE_PATHS
      ? process.env.NEXUS_IGNORE_PATHS.split(',').map(p => p.trim()).filter(Boolean)
      : [];
    return Array.from(new Set([
      'node_modules', '.git', '.nexus', 'dist',
      ...envIgnore
    ]));
  }

  private static async triggerFullScanWithRetry(
    pipeline: IndexPipeline,
    projectRoot: string,
    ignorePaths: string[],
    loadFileContent: (path: string) => Promise<string>,
    retryCount = 3,
    baseDelayMs = 1000
  ): Promise<void> {
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      try {
        const result = await pipeline.reindex(
          () => this.scanDirectory(projectRoot, projectRoot, ignorePaths),
          loadFileContent,
          true
        );

        if (typeof result === 'object' && result !== null && 'status' in result && result.status === 'already_running') {
          throw new Error('already_running');
        }

        console.error('[Nexus] Background full scan completed successfully.');
        return;
      } catch (err) {
        const isAlreadyRunning = err instanceof Error && err.message === 'already_running';
        const logPrefix = `[Nexus] Background full scan ${isAlreadyRunning ? 'skipped (already running)' : 'failed'}`;
        console.error(`${logPrefix} (attempt ${attempt + 1}/${retryCount})`);

        if (attempt < retryCount - 1) {
          const delay = baseDelayMs * 2 ** attempt;
          await new Promise(resolvePromise => setTimeout(resolvePromise, delay));
        }
      }
    }
    console.error('[Nexus] Background full scan exhausted all retry attempts.');
  }

  private static setupEventProcessing(
    config: Config,
    projectRoot: string,
    ignorePaths: string[],
    pipeline: IndexPipeline,
    loadFileContent: (path: string) => Promise<string>
  ) {
    const abortController = new AbortController();

    const triggerFullScan = async () => {
      await this.triggerFullScanWithRetry(pipeline, projectRoot, ignorePaths, loadFileContent);
    };

    const eventQueue = new EventQueue({
      debounceMs: config.watcher.debounceMs,
      maxQueueSize: config.watcher.maxQueueSize,
      fullScanThreshold: config.watcher.fullScanThreshold,
      concurrency: 4,
      onFullScanRequired: () => {
        void triggerFullScan();
        return Promise.resolve();
      },
    });

    const watcher = new FileWatcher({ projectRoot, ignorePaths }, eventQueue);

    // Start background drain loop with cancellation support
    const drainTask = (async () => {
      while (!abortController.signal.aborted) {
        try {
          // If eventQueue.drain supports signal, we should pass it. 
          // Assuming it doesn't, we check signal after each drain.
          await eventQueue.drain(async (event) => {
            if (event.type === 'reindex') await triggerFullScan();
            else await pipeline.processEvents([event], loadFileContent);
          });
        } catch (error) {
          if (!abortController.signal.aborted) {
            console.error('[Nexus] Error in event queue drain loop:', error);
          }
        }
        
        // Wait with cancellation awareness
        await new Promise(resolvePromise => {
          const timer = setTimeout(resolvePromise, 500);
          abortController.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolvePromise(undefined);
          }, { once: true });
        });
      }
    })();

    const onClose = async () => {
      abortController.abort();
      await drainTask;
    };

    return { eventQueue, watcher, onClose };
  }
}

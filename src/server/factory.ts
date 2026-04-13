import { spawn } from 'node:child_process';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

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

    // Ensure storage directories exist
    await mkdir(config.storage.rootDir, { recursive: true });
    await mkdir(dirname(config.storage.metadataDbPath), { recursive: true });
    await mkdir(config.storage.vectorDbPath, { recursive: true });

    const metadataStore = new SqliteMetadataStore({
      databasePath: config.storage.metadataDbPath,
      batchSize: config.storage.batchSize,
    });

    const vectorStore = new LanceVectorStore({
      dbPath: config.storage.vectorDbPath,
      dimensions: config.embedding.dimensions,
    });

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

    const embeddingProvider = pluginRegistry.getEmbeddingProvider();
    if (!embeddingProvider) {
      throw new Error('No embedding provider configured. Please check your configuration.');
    }

    const semanticSearch = new SemanticSearch({ vectorStore, embeddingProvider });

    const grepEngine = new RipgrepEngine({
      projectRoot,
      spawn: async (params, signal) => {
        return new Promise((resolve, reject) => {
          const args = ['--json'];
          if (!params.caseSensitive) {
            args.push('--ignore-case');
          }
          if (params.glob && params.glob.length > 0) {
            params.glob.forEach((g) => args.push('--glob', g));
          }
          args.push('--', params.query, params.cwd ?? projectRoot);

          const child = spawn('rg', args, { signal });
          let stdout = '';
          let stderr = '';

          child.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
          });
          child.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });

          child.on('close', (code) => {
            if (code !== 0 && code !== 1) {
              return reject(new Error(`ripgrep failed with code ${code}: ${stderr}`));
            }

            const lines = stdout.split('\n').filter((l) => l.trim() !== '');
            const matches: GrepMatch[] = [];

            for (const line of lines) {
              try {
                const parsed = JSON.parse(line) as {
                  type: string;
                  data: {
                    path: { text: string };
                    line_number: number;
                    lines: { text: string };
                    submatches: Array<{ start: number; end: number; match: { text: string } }>;
                  };
                };
                if (parsed.type === 'match') {
                  matches.push({
                    filePath: parsed.data.path.text,
                    lineNumber: parsed.data.line_number,
                    lineText: parsed.data.lines.text,
                    submatches: parsed.data.submatches.map((m) => ({
                      start: m.start,
                      end: m.end,
                      match: m.match.text,
                    })),
                  });
                }
              } catch {
                // Ignore non-match lines
              }
            }
            resolve(matches);
          });

          child.on('error', (err) => {
            if (err.name === 'AbortError') {
              resolve([]);
            } else {
              reject(err);
            }
          });
        });
      },
    });

    const orchestrator = new SearchOrchestrator({ semanticSearch, grepEngine, projectRoot });
    const chunker = new Chunker(pluginRegistry);
    const loadFileContent = (path: string) => readFile(path, 'utf8');

    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider,
      pluginRegistry,
    });

    const eventQueue = new EventQueue({
      debounceMs: config.watcher.debounceMs,
      maxQueueSize: config.watcher.maxQueueSize,
      fullScanThreshold: config.watcher.fullScanThreshold,
      concurrency: 4,
      onFullScanRequired: () => {
        console.error('Full scan required due to queue overflow');
        return Promise.resolve();
      },
    });

    const ignorePaths = ['node_modules', '.git', '.nexus', 'dist'];

    const watcher = new FileWatcher(
      {
        projectRoot,
        ignorePaths,
      },
      eventQueue,
    );

    const sanitizer = await PathSanitizer.create(projectRoot);

    return initializeNexusRuntime({
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
        /**
         * Recursively scans the project root to find all files to index,
         * respecting the defined ignore paths.
         */
        const scanDirectory = async (dir: string): Promise<IndexEvent[]> => {
          const entries = await readdir(dir, { withFileTypes: true });
          const events: IndexEvent[] = [];

          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            const relPath = relative(projectRoot, fullPath);
            const segments = relPath.split(sep);

            if (ignorePaths.some((p) => segments.includes(p))) {
              continue;
            }

            if (entry.isDirectory()) {
              events.push(...(await scanDirectory(fullPath)));
            } else if (entry.isFile()) {
              events.push({
                type: 'added',
                filePath: relPath,
                detectedAt: new Date().toISOString(),
              });
            }
          }
          return events;
        };

        let scannedEvents: IndexEvent[] = [];
        const result = await pipeline.reindex(
          async () => {
            scannedEvents = await scanDirectory(projectRoot);
            return scannedEvents;
          },
          loadFileContent,
          args?.fullScan,
        );

        if ('status' in result && result.status === 'already_running') {
          return [];
        }
        return scannedEvents;
      },
      loadFileContent,
    });
  }
}

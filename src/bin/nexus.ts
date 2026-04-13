import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from '../config/index.js';
import { initializeNexusRuntime } from '../server/index.js';
import { PathSanitizer } from '../server/path-sanitizer.js';
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
import type { GrepMatch, IndexEvent } from '../types/index.js';

async function main() {
  const projectRoot = process.cwd();
  const config = await loadConfig({ projectRoot });

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
    pluginRegistry.registerEmbeddingProvider('openai-compat', new OpenAICompatEmbeddingProvider(config.embedding));
    pluginRegistry.setActiveEmbeddingProvider('openai-compat');
  }

  const embeddingProvider = pluginRegistry.getEmbeddingProvider();
  if (!embeddingProvider) {
    throw new Error('No embedding provider configured. Please check your .env or .nexus.json');
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
              // Ignore parse errors for non-match lines
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

  const watcher = new FileWatcher(
    {
      projectRoot,
      ignorePaths: ['node_modules', '.git', '.nexus', 'dist'],
    },
    eventQueue,
  );

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
      let events: IndexEvent[] = [];
      await pipeline.reindex(
        () => {
          // In a full CLI implementation, this would use a recursive directory walker.
          // For now, return an empty array or implement a basic scan if needed.
          events = [];
          return Promise.resolve(events);
        },
        loadFileContent,
        args?.fullScan,
      );
      return events;
    },
    loadFileContent,
  });

  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);

  console.error('Nexus MCP server running on stdio');

  process.on('SIGINT', () => {
    void runtime.close().then(() => {
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    void runtime.close().then(() => {
      process.exit(0);
    });
  });
}

main().catch((error) => {
  console.error('Fatal error starting Nexus:', error);
  process.exit(1);
});

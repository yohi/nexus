import { createServer } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createNexusServer } from '../../src/server/index.js';
import { createStreamableHttpHandler } from '../../src/server/transport.js';
import { SemanticSearch } from '../../src/search/semantic.js';
import { SearchOrchestrator } from '../../src/search/orchestrator.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { TestEmbeddingProvider } from '../unit/plugins/embeddings/test-embedding-provider.js';
import { InMemoryMetadataStore } from '../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../unit/storage/in-memory-vector-store.js';
import { TestGrepEngine } from '../unit/search/test-grep-engine.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { Chunker } from '../../src/indexer/chunker.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import type { CodeChunk } from '../../src/types/index.js';

const makeChunk = (overrides: Partial<CodeChunk>): CodeChunk => ({
  id: overrides.id ?? 'chunk-1',
  filePath: overrides.filePath ?? 'src/auth.ts',
  content: overrides.content ?? 'export function authenticate() {}',
  language: overrides.language ?? 'typescript',
  symbolName: overrides.symbolName,
  symbolKind: overrides.symbolKind ?? 'function',
  startLine: overrides.startLine ?? 1,
  endLine: overrides.endLine ?? 1,
  hash: overrides.hash ?? 'hash-1',
});

describe('Nexus MCP server integration', () => {
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    const metadataStore = new InMemoryMetadataStore();
    const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
    await metadataStore.initialize();
    await vectorStore.initialize();

    const embeddingProvider = new TestEmbeddingProvider();
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.registerLanguage(new TypeScriptLanguagePlugin());
    pluginRegistry.registerEmbeddingProvider('test', embeddingProvider);

    const semanticSearch = new SemanticSearch({ vectorStore, embeddingProvider });
    const grepEngine = new TestGrepEngine();
    grepEngine.addFile('src/auth.ts', 'export function authenticate() {}\n');

    const chunk = makeChunk({
      id: 'src/auth.ts:1',
      filePath: 'src/auth.ts',
      content: 'export function authenticate() {}',
      symbolName: 'authenticate',
    });
    await vectorStore.upsertChunks([chunk], await embeddingProvider.embed([chunk.content]));

    const orchestrator = new SearchOrchestrator({ semanticSearch, grepEngine });
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(pluginRegistry),
      embeddingProvider,
      pluginRegistry,
    });

    const createTestServer = () =>
      createNexusServer({
        projectRoot: process.cwd(),
        semanticSearch,
        grepEngine,
        orchestrator,
        vectorStore,
        metadataStore,
        pipeline,
        pluginRegistry,
        runReindex: async () => [],
        loadFileContent: async (filePath) => {
          if (filePath === 'src/auth.ts') {
            return 'export function authenticate() {}\n';
          }
          throw new Error(`unexpected file: ${filePath}`);
        },
      });
    const handler = createStreamableHttpHandler({ createServer: createTestServer });

    httpServer = createServer((req, res) => {
      void handler(req, res);
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('failed to bind test server');
    }
    baseUrl = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it('accepts a client connection and exposes all six tools', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'get_context',
      'grep_search',
      'hybrid_search',
      'index_status',
      'reindex',
      'semantic_search',
    ]);

    await client.close();
  });

  it('serves multiple clients concurrently', async () => {
    const first = new Client({ name: 'client-a', version: '1.0.0' });
    const second = new Client({ name: 'client-b', version: '1.0.0' });
    const firstTransport = new StreamableHTTPClientTransport(new URL(baseUrl));
    const secondTransport = new StreamableHTTPClientTransport(new URL(baseUrl));

    await Promise.all([first.connect(firstTransport), second.connect(secondTransport)]);
    const [firstTools, secondTools] = await Promise.all([first.listTools(), second.listTools()]);

    expect(firstTools.tools).toHaveLength(6);
    expect(secondTools.tools).toHaveLength(6);

    await Promise.all([first.close(), second.close()]);
  });
});

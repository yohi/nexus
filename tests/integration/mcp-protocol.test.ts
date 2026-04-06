import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createNexusServer } from '../../src/server/index.js';
import { createStreamableHttpHandler } from '../../src/server/transport.js';
import { Chunker } from '../../src/indexer/chunker.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import { SearchOrchestrator } from '../../src/search/orchestrator.js';
import { SemanticSearch } from '../../src/search/semantic.js';
import { TestEmbeddingProvider } from '../unit/plugins/embeddings/test-embedding-provider.js';
import { TestGrepEngine } from '../unit/search/test-grep-engine.js';
import { InMemoryMetadataStore } from '../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../unit/storage/in-memory-vector-store.js';
import { PathSanitizer } from '../../src/server/path-sanitizer.js';
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

describe('Phase 2 MCP protocol integration', () => {
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;
  let client: Client | null = null;
  const fixtureRoot = path.resolve(process.cwd(), 'tests/fixtures/sample-project');
  const authFilePath = path.join(fixtureRoot, 'src/auth.ts');

  beforeEach(async () => {
    const metadataStore = new InMemoryMetadataStore();
    const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
    await metadataStore.initialize();
    await vectorStore.initialize();

    const embeddingProvider = new TestEmbeddingProvider();
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.registerLanguage(new TypeScriptLanguagePlugin());
    pluginRegistry.registerEmbeddingProvider('test', embeddingProvider);
    pluginRegistry.setActiveEmbeddingProvider('test');

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

    const orchestrator = new SearchOrchestrator({ semanticSearch, grepEngine, projectRoot: fixtureRoot });
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(pluginRegistry),
      embeddingProvider,
      pluginRegistry,
    });

    const sanitizer = await PathSanitizer.create(fixtureRoot);

    const createTestServer = () =>
      createNexusServer({
        projectRoot: fixtureRoot,
        sanitizer,
        semanticSearch,
        grepEngine,
        orchestrator,
        vectorStore,
        metadataStore,
        pipeline,
        pluginRegistry,
        runReindex: async () => [],
        loadFileContent: async (filePath) => fs.readFile(filePath === 'src/auth.ts' ? authFilePath : filePath, 'utf8'),
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
    if (client) {
      await client.close();
      client = null;
    }
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

  it('lets an MCP client call all six tools and receive structured responses', async () => {
    client = new Client({ name: 'phase2-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const parseResult = (result: any) => {
      if (result.content?.[0]?.type === 'text') {
        return JSON.parse(result.content[0].text);
      }
      return result.structuredContent;
    };

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'get_context',
      'grep_search',
      'hybrid_search',
      'index_status',
      'reindex',
      'semantic_search',
    ]);

    const semantic = await client.callTool({ name: 'semantic_search', arguments: { query: 'authenticate', topK: 3 } });
    expect(parseResult(semantic)).toMatchObject({
      results: [
        {
          chunk: expect.objectContaining({ filePath: 'src/auth.ts' }),
          source: 'semantic',
        },
      ],
    });

    const grep = await client.callTool({ name: 'grep_search', arguments: { pattern: 'authenticate', maxResults: 5 } });
    expect(parseResult(grep)).toMatchObject({
      matches: [expect.objectContaining({ filePath: 'src/auth.ts', lineNumber: 1 })],
    });

    const hybrid = await client.callTool({
      name: 'hybrid_search',
      arguments: { query: 'authenticate token', grepPattern: 'authenticate', topK: 5 },
    });
    expect(parseResult(hybrid)).toMatchObject({
      query: 'authenticate token',
      results: [
        {
          chunk: expect.objectContaining({ filePath: 'src/auth.ts' }),
          source: 'hybrid',
        },
      ],
    });

    const context = await client.callTool({
      name: 'get_context',
      arguments: { filePath: 'src/auth.ts', startLine: 1, endLine: 1 },
    });
    expect(parseResult(context)).toMatchObject({
      filePath: 'src/auth.ts',
      startLine: 1,
      endLine: 1,
      content: "import { randomUUID } from 'node:crypto';",
    });

    const status = await client.callTool({ name: 'index_status', arguments: {} });
    expect(parseResult(status)).toMatchObject({
      skippedFiles: 0,
      pluginHealth: expect.objectContaining({ healthy: true, embeddings: expect.objectContaining({ provider: 'test' }) }),
      vectorStats: expect.objectContaining({ totalFiles: 1, totalChunks: 1 }),
    });

    const reindex = await client.callTool({ name: 'reindex', arguments: { fullRebuild: true } });
    expect(parseResult(reindex)).toMatchObject({
      reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 0,
    });
  });
});

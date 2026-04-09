import path from 'node:path';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { Chunker } from '../../src/indexer/chunker.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import { SearchOrchestrator } from '../../src/search/orchestrator.js';
import { SemanticSearch } from '../../src/search/semantic.js';
import { createNexusServer } from '../../src/server/index.js';
import { PathSanitizer } from '../../src/server/path-sanitizer.js';
import { createStreamableHttpHandler } from '../../src/server/transport.js';
import type { CodeChunk } from '../../src/types/index.js';
import { TestEmbeddingProvider } from '../unit/plugins/embeddings/test-embedding-provider.js';
import { TestGrepEngine } from '../unit/search/test-grep-engine.js';
import { InMemoryMetadataStore } from '../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../unit/storage/in-memory-vector-store.js';

const CONCURRENT_CLIENTS = 24;
const SESSION_IDLE_TIMEOUT_MS = 2_000;

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

describe('stress: concurrent MCP agents', () => {
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;
  let clients: Client[] = [];
  let projectRoot: string;

  beforeEach(async () => {
    clients = [];
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-concurrent-agents-'));
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, 'src/auth.ts'),
      'export function authenticate() {}\n',
      'utf8',
    );

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

    const orchestrator = new SearchOrchestrator({ semanticSearch, grepEngine, projectRoot });
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(pluginRegistry),
      embeddingProvider,
      pluginRegistry,
    });
    const sanitizer = await PathSanitizer.create(projectRoot);

    const handler = createStreamableHttpHandler({
      createServer: () =>
        createNexusServer({
          projectRoot,
          sanitizer,
          semanticSearch,
          grepEngine,
          orchestrator,
          vectorStore,
          metadataStore,
          pipeline,
          pluginRegistry,
          runReindex: async () => [],
          loadFileContent: async (filePath) => {
            const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
            const normalizedFilePath = filePath.replace(/\\/g, '/');
            if (relativePath === 'src/auth.ts' || normalizedFilePath === 'src/auth.ts') {
              return 'export function authenticate() {}\n';
            }
            throw new Error(`unexpected file: ${filePath}`);
          },
        }),
      sessionIdleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
      sessionCleanupIntervalMs: 100,
    });

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
    const errors: Error[] = [];

    const settled = await Promise.allSettled(clients.map((client) => client.close()));
    for (const result of settled) {
      if (result.status === 'rejected') {
        errors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      }
    }

    clients = [];

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close((error) => {
          if (error) {
            errors.push(error);
          }
          resolve();
        });
      });
    }

    if (projectRoot) {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }

    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new Error(errors.map((error) => error.message).join(', '));
    }
  });

  it('serves many MCP clients performing tool calls in parallel', async () => {
    const createdClients = Array.from({ length: CONCURRENT_CLIENTS }, (_, index) => {
      const client = new Client({ name: `stress-client-${index + 1}`, version: '1.0.0' });
      clients.push(client);
      return client;
    });

    await Promise.all(
      createdClients.map(async (client) => {
        const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
        await client.connect(transport);
      }),
    );

    const responses = await Promise.all(
      createdClients.map(async (client) => {
        const [tools, semantic, grep, hybrid, context, status, reindex] = await Promise.all([
          client.listTools(),
          client.callTool({ name: 'semantic_search', arguments: { query: 'authenticate', topK: 3 } }),
          client.callTool({ name: 'grep_search', arguments: { pattern: 'authenticate', maxResults: 5 } }),
          client.callTool({
            name: 'hybrid_search',
            arguments: { query: 'authenticate token', grepPattern: 'authenticate', topK: 5 },
          }),
          client.callTool({
            name: 'get_context',
            arguments: { filePath: 'src/auth.ts', startLine: 1, endLine: 1 },
          }),
          client.callTool({ name: 'index_status', arguments: {} }),
          client.callTool({ name: 'reindex', arguments: { fullRebuild: true } }),
        ]);

        return {
          tools,
          semantic: parseResult(semantic),
          grep: parseResult(grep),
          hybrid: parseResult(hybrid),
          context: parseResult(context),
          status: parseResult(status),
          reindex: parseResult(reindex),
        };
      }),
    );

    for (const response of responses) {
      expect(response.tools.tools).toHaveLength(6);
      expect(response.semantic).toMatchObject({
        results: [expect.objectContaining({ chunk: expect.objectContaining({ filePath: 'src/auth.ts' }) })],
      });
      expect(response.grep).toMatchObject({
        matches: [expect.objectContaining({ filePath: 'src/auth.ts', lineNumber: 1 })],
      });
      expect(response.hybrid).toMatchObject({
        results: [expect.objectContaining({ chunk: expect.objectContaining({ filePath: 'src/auth.ts' }) })],
      });
      expect(response.context).toMatchObject({
        filePath: 'src/auth.ts',
        startLine: 1,
        endLine: 1,
      });
      expect(response.status).toMatchObject({
        skippedFiles: 0,
        vectorStats: expect.objectContaining({ totalFiles: 1 }),
      });
      expect(response.reindex).toMatchObject({
        reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        chunksIndexed: 0,
      });
    }
  });

  it('accepts new clients after prior idle sessions are cleaned up', async () => {
    const firstWave = Array.from({ length: 8 }, (_, index) => {
      const client = new Client({ name: `first-wave-${index + 1}`, version: '1.0.0' });
      clients.push(client);
      return client;
    });

    await Promise.all(
      firstWave.map(async (client) => {
        const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
        await client.connect(transport);
        await client.callTool({ name: 'index_status', arguments: {} });
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, SESSION_IDLE_TIMEOUT_MS + 1500));

    const secondWave = Array.from({ length: 8 }, (_, index) => {
      const client = new Client({ name: `second-wave-${index + 1}`, version: '1.0.0' });
      clients.push(client);
      return client;
    });

    const results = await Promise.all(
      secondWave.map(async (client) => {
        const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
        await client.connect(transport);
        return parseResult(await client.callTool({ name: 'index_status', arguments: {} }));
      }),
    );

    for (const result of results) {
      expect(result).toMatchObject({
        skippedFiles: 0,
        pluginHealth: expect.objectContaining({ healthy: true, isOperational: true }),
      });
    }
  });
});

const parseResult = (result: unknown) => {
  const candidate = result as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };

  if (candidate.content?.[0]?.type === 'text' && typeof candidate.content[0].text === 'string') {
    try {
      return JSON.parse(candidate.content[0].text) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Failed to parse candidate.content[0].text: ${candidate.content[0].text}. Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (candidate.structuredContent !== undefined) {
    return candidate.structuredContent as Record<string, unknown>;
  }

  throw new Error(`Invalid result: neither parsable text nor structuredContent was available. Candidate: ${JSON.stringify(candidate)}`);
};

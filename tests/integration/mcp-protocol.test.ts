import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createNexusServer } from '../../src/server/index.js';
import { NexusServerFactory } from '../../src/server/factory.js';
import { createStreamableHttpHandler } from '../../src/server/transport.js';
import { loadConfig } from '../../src/config/index.js';
import { SqliteMetadataStore } from '../../src/storage/metadata-store.js';
import { createMockMetricsHooks } from '../shared/test-helpers.js';
import { createTestNexusOptions } from '../shared/create-test-nexus-options.js';
import { storageOwnershipAdmissionService } from '../../src/server/storage-ownership/admission.js';
import {
  connectMcpClient,
  startMcpHttpTestServer,
  type McpHttpTestServer,
} from '../shared/mcp-http-test-helpers.js';

describe('Phase 2 MCP protocol integration', () => {
  let httpTestServer: McpHttpTestServer;
  let baseUrl: string;
  let client: Client | null = null;
  let mockMetricsHooks: ReturnType<typeof createMockMetricsHooks>;
  const fixtureRoot = path.resolve(process.cwd(), 'tests/fixtures/sample-project');

  const parseResult = (result: any) => {
    if (result.content?.[0]?.type === 'text') {
      return JSON.parse(result.content[0].text);
    }
    return result.structuredContent;
  };

  beforeEach(async () => {
    mockMetricsHooks = createMockMetricsHooks();
    const { options } = await createTestNexusOptions({
      projectRoot: fixtureRoot,
      bootstrapStructuredSchema: true,
      loadFileContent: async (filePath) => fs.readFile(filePath, 'utf8'),
      metricsHooks: mockMetricsHooks,
    });
    httpTestServer = await startMcpHttpTestServer(() => createNexusServer(options));
    baseUrl = httpTestServer.baseUrl;
  });

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    await httpTestServer.dispose();
  });

  const connectClient = async (): Promise<Client> => {
    const connectedClient = await connectMcpClient(baseUrl, 'phase2-client');
    client = connectedClient;
    return connectedClient;
  };

  it('lets an MCP client call all six tools and receive structured responses', async () => {
    const mcpClient = await connectClient();

    const tools = await mcpClient.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'get_context',
      'get_definition',
      'get_file_outline',
      'get_implementations',
      'get_references',
      'get_symbol_context',
      'get_symbol_source',
      'grep_search',
      'hybrid_search',
      'index_status',
      'reindex',
      'semantic_search',
    ]);
    expect(Object.fromEntries(tools.tools.map((tool) => [tool.name, tool.description]))).toEqual({
      get_context: 'Return a specific line range from a file; prefer partial reads.',
      get_definition: 'Return live LSP definition locations for a symbolId or file position (TS/JS).',
      get_file_outline: 'Return a source-free structured outline of a known file.',
      get_implementations: 'Return live LSP implementation locations for a symbolId or file position (TS/JS).',
      get_references: 'Return live LSP reference locations for a symbolId or file position (TS/JS).',
      get_symbol_context: 'Return bounded context (verified imports + exact symbol source) for a symbol ID.',
      get_symbol_source: 'Return exact source for a structured symbol ID.',
      grep_search: 'Exact string search for symbols, errors, or code fragments.',
      hybrid_search: 'Semantic + grep hybrid search for vague or conceptual queries.',
      index_status: 'Check indexing progress and statistics before searching.',
      reindex: 'Manually rebuild the local search index.',
      semantic_search: 'Vector-only semantic search; prefer hybrid_search for most tasks.',
    });
    expect(
      Object.fromEntries(
        tools.tools.map((tool) => {
          expect(tool.inputSchema).toBeDefined();
          expect(tool.inputSchema.properties).toBeDefined();
          return [
            tool.name,
            Object.keys(tool.inputSchema.properties as Record<string, unknown>).sort(),
          ];
        }),
      ),
    ).toEqual({
      get_context: ['endLine', 'filePath', 'mode', 'startLine', 'symbolName'],
      get_definition: ['character', 'filePath', 'line', 'symbolId'],
      get_file_outline: ['filePath'],
      get_implementations: ['character', 'filePath', 'line', 'symbolId'],
      get_references: ['character', 'filePath', 'line', 'maxResults', 'symbolId'],
      get_symbol_context: ['symbolId', 'tokenBudget'],
      get_symbol_source: ['symbolId'],
      grep_search: ['caseSensitive', 'filePattern', 'filePatterns', 'maxResults', 'pattern'],
      hybrid_search: ['contextLines', 'filePattern', 'filePatterns', 'grepPattern', 'includeSnippet', 'language', 'query', 'topK'],
      index_status: [],
      reindex: ['fullRebuild', 'reason'],
      semantic_search: ['filePattern', 'filePatterns', 'language', 'query', 'topK'],
    });

    const semantic = await mcpClient.callTool({ name: 'semantic_search', arguments: { query: 'authenticate', topK: 3 } });
    expect(parseResult(semantic)).toMatchObject({
      results: [
        {
          chunk: expect.objectContaining({ filePath: 'src/auth.ts' }),
          source: 'semantic',
        },
      ],
    });

    const grep = await mcpClient.callTool({ name: 'grep_search', arguments: { pattern: 'authenticate', maxResults: 5 } });
    expect(parseResult(grep)).toMatchObject({
      matches: [expect.objectContaining({ filePath: 'src/auth.ts', lineNumber: 1 })],
    });

    const hybrid = await mcpClient.callTool({
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

    const context = await mcpClient.callTool({
      name: 'get_context',
      arguments: { filePath: 'src/auth.ts', startLine: 1, endLine: 1 },
    });
    expect(parseResult(context)).toMatchObject({
      filePath: 'src/auth.ts',
      startLine: 1,
      endLine: 1,
      content: "import { randomUUID } from 'node:crypto';",
    });

    const status = await mcpClient.callTool({ name: 'index_status', arguments: {} });
    expect(parseResult(status)).toMatchObject({
      skippedFiles: 0,
      pluginHealth: expect.objectContaining({ healthy: true, embeddings: expect.objectContaining({ provider: 'test' }) }),
      vectorStats: expect.objectContaining({ totalFiles: 1, totalChunks: 1 }),
    });

    const reindex = await mcpClient.callTool({
      name: 'reindex',
      arguments: { fullRebuild: true, reason: 'startup-reconciliation' },
    });
    expect(parseResult(reindex)).toMatchObject({
      reconciliation: { added: 0, modified: 0, deleted: 1, unchanged: 0 },
      chunksIndexed: 0,
    });

    for (const name of ['get_definition', 'get_references', 'get_implementations']) {
      const navigation = await mcpClient.callTool({
        name,
        arguments: { filePath: 'src/auth.ts', line: 1, character: 0 },
      });
      expect(navigation.isError).toBeFalsy();
      expect(parseResult(navigation)).toEqual({
        status: 'unavailable',
        capability: 'unavailable',
        locations: [],
        truncated: false,
        sourceValidation: 'unknown',
        reasonCode: 'LSP_NOT_CONFIGURED',
      });
    }
  });

  it('records the preview line count via onContextLinesFetched for deferred get_context calls', async () => {
    const mcpClient = await connectClient();

    const result = await mcpClient.callTool({
      name: 'get_context',
      arguments: { filePath: 'src/auth.ts', mode: 'deferred', startLine: 5 },
    });

    const parsed = parseResult(result);
    expect(parsed).toEqual({
      filePath: 'src/auth.ts',
      mode: 'deferred',
      totalLines: expect.any(Number),
      summary: expect.any(String),
      previewStartLine: expect.any(Number),
      previewEndLine: expect.any(Number),
      hint: expect.any(String),
    });
    expect(parsed).not.toHaveProperty('content');
    expect(parsed).not.toHaveProperty('startLine');
    expect(parsed).not.toHaveProperty('endLine');
    expect(mockMetricsHooks.onContextLinesFetched).toHaveBeenCalledWith('get_context', 20);
  });

  it('returns the full eager response shape when get_context mode is omitted', async () => {
    const mcpClient = await connectClient();

    const result = await mcpClient.callTool({
      name: 'get_context',
      arguments: { filePath: 'src/auth.ts', startLine: 1, endLine: 1 },
    });

    const parsed = parseResult(result);
    expect(parsed).toEqual({
      filePath: 'src/auth.ts',
      content: expect.any(String),
      startLine: expect.any(Number),
      endLine: expect.any(Number),
    });
    expect(parsed).not.toHaveProperty('mode');
    expect(parsed).not.toHaveProperty('totalLines');
    expect(parsed).not.toHaveProperty('summary');
    expect(mockMetricsHooks.onContextLinesFetched).toHaveBeenCalledWith('get_context', 1);
  });

  it('attaches populated snippet fields to hybrid_search results when includeSnippet is true', async () => {
    const mcpClient = await connectClient();

    const hybrid = await mcpClient.callTool({
      name: 'hybrid_search',
      arguments: { query: 'authenticate token', grepPattern: 'authenticate', includeSnippet: true },
    });

    const parsed = parseResult(hybrid);
    expect(typeof parsed.results[0]?.snippet).toBe('string');
    expect(parsed.results[0]?.snippet.length).toBeGreaterThan(0);
    expect(typeof parsed.results[0]?.snippetStartLine).toBe('number');
    expect(typeof parsed.results[0]?.snippetEndLine).toBe('number');
    expect(mockMetricsHooks.onContextLinesFetched).toHaveBeenCalledTimes(1);
    expect(mockMetricsHooks.onContextLinesFetched).toHaveBeenCalledWith('hybrid_search', 4);
  });
});

describe('MCP reindex factory integration', () => {
  it('returns a normal reindex result when the factory scanner callback is used', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-mcp-reindex-'));
    const config = await loadConfig({ projectRoot, env: {} });
    // Nexus #297: claim the storage (as a previous runtime would have) before seeding the metadata DB directly.
    const ownership = storageOwnershipAdmissionService;
    await (await ownership.admitStorageWriter(await ownership.resolveStorageOwnershipTargets(config))).release();
    const metadataStore = new SqliteMetadataStore({
      databasePath: config.storage.metadataDbPath,
      batchSize: config.storage.batchSize,
    });
    await metadataStore.initialize();
    await metadataStore.bootstrapStructuredSchema();
    await metadataStore.setIndexStats({
      id: 'primary',
      totalFiles: 0,
      totalChunks: 0,
      lastIndexedAt: new Date().toISOString(),
      lastFullScanAt: null,
      overflowCount: 0,
      lastError: null,
    });
    await metadataStore.close();
    const runtime = await NexusServerFactory.createRuntime(config);
    const handler = createStreamableHttpHandler({ createServer: () => runtime.createServer() });
    const httpServer = createServer((req, res) => {
      void handler(req, res);
    });
    const client = new Client({ name: 'reindex-client', version: '1.0.0' });

    try {
      await new Promise<void>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => resolve());
      });
      const address = httpServer.address();
      if (address === null || typeof address === 'string') {
        throw new Error('failed to bind reindex test server');
      }
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp`),
      );
      await client.connect(transport);

      const result = await client.callTool({
        name: 'reindex',
        arguments: { fullRebuild: false },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
        durationMs: expect.any(Number),
        reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        chunksIndexed: 0,
      });
      expect(result.structuredContent).not.toMatchObject({ status: 'already_running' });
    } finally {
      await client.close();
      await handler.dispose();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await runtime.close();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

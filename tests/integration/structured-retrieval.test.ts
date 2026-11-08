import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { createNexusServer } from '../../src/server/index.js';
import { createMockMetricsHooks } from '../shared/test-helpers.js';
import { createTestNexusOptions } from '../shared/create-test-nexus-options.js';
import {
  connectMcpClient,
  startMcpHttpTestServer,
  type McpHttpTestServer,
} from '../shared/mcp-http-test-helpers.js';
import {
  createStructuredCoordinator,
  createStructuredStage,
  stageStructuredFile,
} from '../shared/structured-test-helpers.js';

const parseResult = (result: any) => {
  if (result.content?.[0]?.type === 'text') {
    return JSON.parse(result.content[0].text);
  }
  return result.structuredContent;
};

describe('Structured retrieval MCP integration', () => {
  let httpTestServer: McpHttpTestServer;
  let baseUrl: string;
  let client: Client | null = null;
  let projectRoot: string;
  let mockMetricsHooks: ReturnType<typeof createMockMetricsHooks>;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-structured-retrieval-'));
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });

    const chunkText = 'export function authenticate() { return true; }';
    mockMetricsHooks = createMockMetricsHooks();

    await writeFile(path.join(projectRoot, 'src/auth.ts'), chunkText);

    const context = await createTestNexusOptions({
      projectRoot,
      fileContent: chunkText,
      chunkContent: chunkText,
      bootstrapStructuredSchema: true,
      metricsHooks: mockMetricsHooks,
    });
    const { options, metadataStore, vectorStore } = context;
    const stage = createStructuredStage('src/auth.ts', chunkText, 'authenticate', {
      signatureDiscriminator: '()',
      endColumn: chunkText.length,
    });
    const coordinator = createStructuredCoordinator({
      metadataStore,
      vectorStore,
      pluginRegistry: options.pluginRegistry,
    });
    await stageStructuredFile(coordinator, stage);
    await coordinator.activateFile({ filePath: stage.source.filePath, generationId: stage.generationId });

    httpTestServer = await startMcpHttpTestServer(() => createNexusServer(options));
    baseUrl = httpTestServer.baseUrl;
  });

  const connectClient = async (): Promise<Client> => {
    const connectedClient = await connectMcpClient(baseUrl, 'structured-client');
    client = connectedClient;
    return connectedClient;
  };

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    await httpTestServer.dispose();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('exposes structured retrieval tools in the tool catalog', async () => {
    const mcpClient = await connectClient();

    const tools = await mcpClient.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
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
  });

  it('returns a file outline for a structured indexed file', async () => {
    const mcpClient = await connectClient();

    const result = await mcpClient.callTool({
      name: 'get_file_outline',
      arguments: { filePath: 'src/auth.ts' },
    });
    const parsed = parseResult(result);
    expect(parsed).toMatchObject({
      status: 'ok',
    });
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'authenticate',
          symbolId: expect.any(String),
          kind: 'function',
        }),
      ]),
    );
    expect(mockMetricsHooks.onStructuredRetrievalOutcome).toHaveBeenCalledWith('get_file_outline', 'ok');
  });

  it('returns exact symbol source for a known symbol id', async () => {
    const mcpClient = await connectClient();

    const outline = parseResult(
      await mcpClient.callTool({ name: 'get_file_outline', arguments: { filePath: 'src/auth.ts' } }),
    );
    const symbolId = outline.symbols.find((d: any) => d.name === 'authenticate')?.symbolId;
    expect(symbolId).toBeDefined();

    const result = await mcpClient.callTool({
      name: 'get_symbol_source',
      arguments: { symbolId },
    });
    const parsed = parseResult(result);
    expect(parsed).toMatchObject({
      status: 'ok',
      freshness: 'fresh',
      source: 'export function authenticate() { return true; }',
    });
    expect(mockMetricsHooks.onStructuredRetrievalOutcome).toHaveBeenCalledWith('get_symbol_source', 'ok');
  });

  it('returns bounded symbol context with budget metadata', async () => {
    const mcpClient = await connectClient();

    const outline = parseResult(
      await mcpClient.callTool({ name: 'get_file_outline', arguments: { filePath: 'src/auth.ts' } }),
    );
    const symbolId = outline.symbols.find((d: any) => d.name === 'authenticate')?.symbolId;
    expect(symbolId).toBeDefined();

    const result = await mcpClient.callTool({
      name: 'get_symbol_context',
      arguments: { symbolId, tokenBudget: 500 },
    });
    const parsed = parseResult(result);
    expect(parsed).toMatchObject({
      status: 'ok',
      request: { symbolId, tokenBudget: 500 },
    });
    expect(parsed.budget).toMatchObject({
      requested: 500,
      actual: expect.any(Number),
      exceeded: false,
      omittedForBudget: 0,
    });
    expect(parsed.context).toEqual('export function authenticate() { return true; }');
    expect(mockMetricsHooks.onStructuredRetrievalOutcome).toHaveBeenCalledWith('get_symbol_context', 'ok');
    expect(mockMetricsHooks.onStructuredContextTokens).toHaveBeenCalled();
  });

  it('returns an error response when the file is not structured-indexed', async () => {
    const mcpClient = await connectClient();

    const result = await mcpClient.callTool({
      name: 'get_file_outline',
      arguments: { filePath: 'src/not-indexed.ts' },
    });
    const parsed = parseResult(result);
    expect(parsed).toMatchObject({
      status: 'not_found',
      request: { filePath: 'src/not-indexed.ts' },
    });
    expect(mockMetricsHooks.onStructuredRetrievalOutcome).toHaveBeenCalledWith('get_file_outline', 'not_found');
  });

  it('reports structured index status in index_status', async () => {
    const mcpClient = await connectClient();

    const result = parseResult(await mcpClient.callTool({ name: 'index_status', arguments: {} }));
    expect(result.structuredIndex).toMatchObject({
      schemaVersion: 1,
      targetSchemaVersion: 1,
      status: 'idle',
      totalFiles: 1,
      totalSymbols: 1,
      exactFiles: 1,
      pendingFiles: 0,
      reindexRequired: false,
    });
  });
});

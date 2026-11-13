import path from 'node:path';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createNexusServer } from '../../src/server/index.js';
import { createStreamableHttpHandler } from '../../src/server/transport.js';
import { createTestNexusOptions } from '../shared/create-test-nexus-options.js';

const CONCURRENT_CLIENTS = 24;
const SESSION_IDLE_TIMEOUT_MS = 5_000;

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

    const { options } = await createTestNexusOptions({ projectRoot });

    const handler = createStreamableHttpHandler({
      createServer: () => createNexusServer(options),
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
      if (errors.length === 1) {
        throw errors[0];
      }
      throw new AggregateError(
        errors,
        `Multiple errors: ${errors.map((e) => e.message).join(', ')}`
      );
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
        const [tools, semantic, grep, hybrid, context, status] = await Promise.all([
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
        ]);

        return {
          tools,
          semantic: parseResult(semantic),
          grep: parseResult(grep),
          hybrid: parseResult(hybrid),
          context: parseResult(context),
          status: parseResult(status),
        };
      }),
    );

    const reindexes = await Promise.all(createdClients.map(async (client) =>
      parseResult(await client.callTool({ name: 'reindex', arguments: { fullRebuild: true } })),
    ));

    for (const [index, response] of responses.entries()) {
      expect(response.tools.tools).toHaveLength(12);
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
      const reindex = reindexes[index];
      if (reindex === undefined) throw new Error('missing reindex response');
      if ('status' in reindex) {
        expect(reindex.status).toBe('integrity_unknown');
        expect(reindex.reason).toBe('embedding_identity_unavailable');
      } else {
        expect(reindex).toMatchObject({
          reconciliation: { added: 0, modified: 0, deleted: 1, unchanged: 0 },
          chunksIndexed: 0,
        });
      }
    }
  }, 20000);

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

    await new Promise((resolve) => setTimeout(resolve, SESSION_IDLE_TIMEOUT_MS + 500));

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
  }, 30000);
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

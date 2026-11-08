import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as V1McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';

import { startHttpV2Server, type HttpV2ServerHandle } from '../../../src/server/http-v2/entry.js';
import { createV2McpHandler } from '../../../src/server/http-v2/server-factory.js';
import { registerV1Tools } from '../../../src/server/tools/registry/adapters/v1-adapter.js';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import { createTestNexusOptions } from '../../shared/create-test-nexus-options.js';

const PROTOCOL_VERSION = '2026-07-28';

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const readJsonRpc = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text();
  const dataLines = text.split('\n').filter((line) => line.startsWith('data:'));
  const payload = dataLines.length === 0 ? text : (dataLines.at(-1) ?? '').slice(5).trim();
  return JSON.parse(payload) as Record<string, unknown>;
};

const modernParams = (params: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...params,
  _meta: {
    [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: {},
  },
});

const modernHeaders = (request: JsonRpcRequest): Headers => {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    'mcp-method': request.method,
  });
  const toolName = request.params['name'];
  if (request.method === 'tools/call' && typeof toolName === 'string') {
    headers.set('mcp-name', toolName);
  }
  return headers;
};

const postModernMcp = (baseUrl: string, request: JsonRpcRequest, headers?: Headers): Promise<Response> =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: headers ?? modernHeaders(request),
    body: JSON.stringify(request),
  });

describe('HTTP v2 server', () => {
  let handle: HttpV2ServerHandle | undefined;
  let ready = true;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    ready = true;
  });

  const boot = async (): Promise<string> => {
    const { options } = await createTestNexusOptions();
    const handler = createV2McpHandler({
      options,
      awaitInitialize: async () => {},
      limits: { topK: 100, maxResults: 1000 },
    });
    handle = await startHttpV2Server({
      handler,
      isReady: () => ready,
      host: '127.0.0.1',
      port: 0,
    });
    return `http://127.0.0.1:${handle.port()}`;
  };

  it('serves health and ready endpoints', async () => {
    const baseUrl = await boot();

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    ready = false;
    const unavailable = await fetch(`${baseUrl}/ready`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      status: 'not_ready',
      reason: 'NEXUS_STORAGE_UNAVAILABLE',
    });

    ready = true;
    const available = await fetch(`${baseUrl}/ready`);
    expect(available.status).toBe(200);
    expect(await available.json()).toEqual({ status: 'ready' });
  });

  it('lists six tools without a session ID through a real HTTP port', async () => {
    const baseUrl = await boot();
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: modernParams(),
    };

    const response = await postModernMcp(baseUrl, request);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = await readJsonRpc(response);
    const result = body['result'] as { tools: unknown[] };
    expect(result.tools).toHaveLength(12);
  });

  it('returns 405 for non-POST /mcp and 404 for unrelated paths', async () => {
    const baseUrl = await boot();

    expect((await fetch(`${baseUrl}/nope`, { method: 'POST' })).status).toBe(404);
    const response = await fetch(`${baseUrl}/mcp`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect((await fetch(`${baseUrl}/mcp`, { method: 'DELETE' })).status).toBe(405);
  });

  it('rejects non-loopback origins before the MCP handler', async () => {
    const baseUrl = await boot();
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: modernParams(),
    };
    const headers = modernHeaders(request);
    headers.set('origin', 'https://evil.example');

    const response = await postModernMcp(baseUrl, request, headers);

    expect(response.status).toBe(403);
  });

  it('rejects 2025-era requests', async () => {
    const baseUrl = await boot();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-03-26',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('returns the same hybrid_search result paths as the v1 adapter', async () => {
    const { options } = await createTestNexusOptions();
    const v1Server = new V1McpServer(
      { name: 'nexus', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    registerV1Tools(v1Server, buildToolHandlers(options));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const v1Client = new V1Client({ name: 'v1-parity-client', version: '0.0.1' });

    let v1Paths: string[];
    try {
      await Promise.all([v1Server.connect(serverTransport), v1Client.connect(clientTransport)]);
      const result = await v1Client.callTool({
        name: 'hybrid_search',
        arguments: { query: 'authenticate', grepPattern: 'authenticate' },
      });
      const structured = result.structuredContent as { results: Array<{ filePath: string }> };
      v1Paths = structured.results.map((entry) => entry.filePath).sort();
    } finally {
      await v1Client.close();
      await v1Server.close();
    }

    const handler = createV2McpHandler({
      options,
      awaitInitialize: async () => {},
      limits: { topK: 100, maxResults: 1000 },
    });
    handle = await startHttpV2Server({
      handler,
      isReady: () => true,
      host: '127.0.0.1',
      port: 0,
    });
    const baseUrl = `http://127.0.0.1:${handle.port()}`;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: modernParams({
        name: 'hybrid_search',
        arguments: { query: 'authenticate', grepPattern: 'authenticate' },
      }),
    };

    const response = await postModernMcp(baseUrl, request);

    expect(response.status).toBe(200);
    const body = await readJsonRpc(response);
    const result = body['result'] as { structuredContent: { results: Array<{ filePath: string }> } };
    expect(result.structuredContent.results.map((entry) => entry.filePath).sort()).toEqual(v1Paths);
  });
});

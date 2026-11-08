import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { createV2McpHandler } from '../../../../src/server/http-v2/server-factory.js';
import { createTestNexusOptions } from '../../../shared/create-test-nexus-options.js';

const PROTOCOL_VERSION = '2026-07-28';

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': PROTOCOL_VERSION,
} as const;

const modernParams = (params: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...params,
  _meta: {
    [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: {},
  },
});

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const post = (body: JsonRpcRequest, headers: Record<string, string> = MCP_HEADERS): Request => {
  const requestHeaders = new Headers(headers);
  if (requestHeaders.get('mcp-protocol-version') === PROTOCOL_VERSION) {
    requestHeaders.set('mcp-method', body.method);
    const toolName = body.params['name'];
    if (body.method === 'tools/call' && typeof toolName === 'string') {
      requestHeaders.set('mcp-name', toolName);
    }
  }

  return new Request('http://127.0.0.1:9200/mcp', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
};

const readJsonRpc = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text();
  const dataLines = text.split('\n').filter((line) => line.startsWith('data:'));
  const payload = dataLines.length === 0 ? text : (dataLines.at(-1) ?? '').slice(5).trim();
  return JSON.parse(payload) as Record<string, unknown>;
};

const createHandler = async () => {
  const { options } = await createTestNexusOptions();
  return createV2McpHandler({
    options,
    awaitInitialize: async () => {},
    limits: { topK: 100, maxResults: 1000 },
  });
};

describe('createV2McpHandler', () => {
  it('lists all twelve tools without a session header', async () => {
    const handler = await createHandler();
    const response = await handler.fetch(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: modernParams() }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = await readJsonRpc(response);
    const result = body['result'] as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'semantic_search',
      'grep_search',
      'hybrid_search',
      'get_context',
      'index_status',
      'reindex',
      'get_file_outline',
      'get_symbol_source',
      'get_symbol_context',
      'get_definition',
      'get_references',
      'get_implementations',
    ]);
    await handler.close();
  });

  it('answers server/discover with nexus server metadata', async () => {
    const handler = await createHandler();
    const response = await handler.fetch(
      post({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: modernParams() }),
    );

    expect(response.status).toBe(200);
    const body = await readJsonRpc(response);
    const result = body['result'] as { _meta?: Record<string, { name?: string }> };
    expect(result._meta?.['io.modelcontextprotocol/serverInfo']?.name).toBe('nexus');
    await handler.close();
  });

  it('calls grep_search through the stateless handler', async () => {
    const handler = await createHandler();
    const response = await handler.fetch(
      post({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: modernParams({ name: 'grep_search', arguments: { pattern: 'authenticate' } }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await readJsonRpc(response);
    const result = body['result'] as { structuredContent?: { matches: unknown[] } };
    expect(result.structuredContent?.matches).toHaveLength(1);
    await handler.close();
  });

  it('rejects legacy 2025-era requests', async () => {
    const handler = await createHandler();
    const response = await handler.fetch(
      post(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { ...MCP_HEADERS, 'mcp-protocol-version': '2025-03-26' },
      ),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    await handler.close();
  });
});

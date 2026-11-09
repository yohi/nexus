import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildToolHandlers } from '../../../../../../src/server/tools/tool-support.js';
import { registerV1Tools, toZodV3Field } from '../../../../../../src/server/tools/registry/adapters/v1-adapter.js';
import { createTestNexusOptions } from '../../../../../shared/create-test-nexus-options.js';

const EXPECTED_TOOLS = [
  {
    name: 'semantic_search',
    description: 'Vector-only semantic search; prefer hybrid_search for most tasks.',
    required: ['query'],
  },
  {
    name: 'grep_search',
    description: 'Exact string search for symbols, errors, or code fragments.',
    required: ['pattern'],
  },
  {
    name: 'hybrid_search',
    description: 'Semantic + grep hybrid search for vague or conceptual queries.',
    required: ['query'],
  },
  {
    name: 'get_context',
    description: 'Return a specific line range from a file; prefer partial reads.',
    required: ['filePath'],
  },
  {
    name: 'index_status',
    description: 'Check indexing progress and statistics before searching.',
    required: [],
  },
  {
    name: 'reindex',
    description: 'Manually rebuild the local search index.',
    required: [],
  },
  {
    name: 'get_file_outline',
    description: 'Return a source-free structured outline of a known file.',
    required: ['filePath'],
  },
  {
    name: 'get_symbol_source',
    description: 'Return exact source for a structured symbol ID.',
    required: ['symbolId'],
  },
  {
    name: 'get_symbol_context',
    description: 'Return bounded context (verified imports + exact symbol source) for a symbol ID.',
    required: ['symbolId', 'tokenBudget'],
  },
  {
    name: 'get_definition',
    description: 'Return live LSP definition locations for a symbolId or file position (TS/JS).',
    required: [],
  },
  {
    name: 'get_references',
    description: 'Return live LSP reference locations for a symbolId or file position (TS/JS).',
    required: [],
  },
  {
    name: 'get_implementations',
    description: 'Return live LSP implementation locations for a symbolId or file position (TS/JS).',
    required: [],
  },
] as const;

describe('v1 adapter parity', () => {
  let client: Client | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
  });

  const connect = async (): Promise<Client> => {
    const { options } = await createTestNexusOptions();
    server = new McpServer(
      { name: 'nexus', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    registerV1Tools(server, buildToolHandlers(options));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'v1-parity-client', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };

  it('lists the 12 tools with legacy names, descriptions and required params', async () => {
    const connected = await connect();
    const listed = await connected.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS.map((tool) => tool.name));
    for (const expected of EXPECTED_TOOLS) {
      const actual = listed.tools.find((tool) => tool.name === expected.name);
      expect(actual?.description).toBe(expected.description);
      expect(actual?.inputSchema.required ?? []).toEqual(expected.required);
    }
  });

  it('calls grep_search and returns the legacy structuredContent shape', async () => {
    const connected = await connect();
    const result = await connected.callTool({ name: 'grep_search', arguments: { pattern: 'authenticate' } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      matches: [expect.objectContaining({ filePath: 'src/auth.ts' })],
    });
  });

  it('keeps the legacy error shape on the v1 path', async () => {
    const connected = await connect();
    const result = await connected.callTool({ name: 'get_context', arguments: { filePath: 'nope.ts' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: true });
    expect(result.structuredContent).not.toHaveProperty('code');
  });

  it.each(['get_definition', 'get_references', 'get_implementations'])(
    'returns unavailable/LSP_NOT_CONFIGURED from %s when no navigation service is assembled',
    async (name) => {
      const connected = await connect();
      const result = await connected.callTool({
        name,
        arguments: { filePath: 'src/auth.ts', line: 1, character: 0 },
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        status: 'unavailable',
        capability: 'unavailable',
        locations: [],
        truncated: false,
        sourceValidation: 'unknown',
        reasonCode: 'LSP_NOT_CONFIGURED',
      });
    },
  );

  it('rejects a mixed navigation target as a tool error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const connected = await connect();
    const result = await connected.callTool({
      name: 'get_definition',
      arguments: { symbolId: 'symbol_v1_1234567890123456789012345678901234567890123', filePath: 'src/auth.ts' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: true });
    consoleError.mockRestore();
  });

  it('allows integer minimum of 0 in the v1 adapter', () => {
    const schema = toZodV3Field({ kind: 'integer', minimum: 0 });
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse(-1).success).toBe(false);
    expect(schema.safeParse(1).success).toBe(true);
  });

  it('preserves default integer minimum of 1', () => {
    const schema = toZodV3Field({ kind: 'integer' });
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(1).success).toBe(true);
  });

  it('enforces integer maximum in the v1 adapter', () => {
    const schema = toZodV3Field({ kind: 'integer', minimum: 1, maximum: 100000 });
    expect(schema.safeParse(100000).success).toBe(true);
    expect(schema.safeParse(100001).success).toBe(false);
  });
});

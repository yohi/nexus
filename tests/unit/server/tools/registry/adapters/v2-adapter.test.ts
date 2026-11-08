import { describe, expect, it } from 'vitest';
import { z as z3 } from 'zod';

import { TOOL_DEFINITIONS } from '../../../../../../src/server/tools/registry/definitions.js';
import type { ToolHandler } from '../../../../../../src/server/tools/types.js';
import { toZodV3Shape } from '../../../../../../src/server/tools/registry/adapters/v1-adapter.js';
import {
  toV2JsonSchema,
  toZodV4Object,
  withErrorCode,
} from '../../../../../../src/server/tools/registry/adapters/v2-adapter.js';

describe('v1/v2 schema parity', () => {
  const validArgs: Record<string, Record<string, unknown>> = {
    semantic_search: { query: 'auth', topK: 5 },
    grep_search: { pattern: 'foo', maxResults: 10, caseSensitive: true },
    hybrid_search: { query: 'auth', topK: 5, contextLines: 3 },
    get_context: { filePath: 'src/a.ts', startLine: 1, endLine: 5 },
    index_status: {},
    reindex: { fullRebuild: true },
    get_file_outline: { filePath: 'src/a.ts' },
    get_symbol_source: { symbolId: 'symbol_v1_1234567890123456789012345678901234567890123' },
    get_symbol_context: { symbolId: 'symbol_v1_1234567890123456789012345678901234567890123', tokenBudget: 512 },
    get_definition: { filePath: 'src/a.ts', line: 1, character: 0 },
    get_references: { symbolId: 'symbol_v1_1234567890123456789012345678901234567890123', maxResults: 10 },
    get_implementations: { filePath: 'src/a.ts', line: 3, character: 7 },
  };

  it('accepts the same valid inputs in v3 and v4', () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect(z3.object(toZodV3Shape(definition.input)).safeParse(validArgs[definition.name]).success).toBe(true);
      expect(toZodV4Object(definition.input).safeParse(validArgs[definition.name]).success).toBe(true);
    }
  });

  it('rejects over-limit integers in both v3 and v4', () => {
    const hybrid = TOOL_DEFINITIONS.find((definition) => definition.name === 'hybrid_search');
    const grep = TOOL_DEFINITIONS.find((definition) => definition.name === 'grep_search');
    if (hybrid === undefined || grep === undefined) {
      throw new Error('expected definitions are missing');
    }
    expect(z3.object(toZodV3Shape(hybrid.input)).safeParse({ query: 'auth', topK: 101 }).success).toBe(false);
    expect(toZodV4Object(hybrid.input).safeParse({ query: 'auth', topK: 101 }).success).toBe(false);
    expect(toZodV4Object(hybrid.input).safeParse({ query: 'auth', contextLines: 21 }).success).toBe(false);
    expect(z3.object(toZodV3Shape(grep.input)).safeParse({ pattern: 'x', maxResults: 1001 }).success).toBe(false);
    expect(toZodV4Object(grep.input).safeParse({ pattern: 'x', maxResults: 1001 }).success).toBe(false);
  });

  it('parses navigation targets equivalently in v3 and v4', () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['get_definition', { filePath: 'src/a.ts', line: 1, character: 0 }, true],
      ['get_definition', { filePath: 'src/a.ts', line: 0, character: 0 }, false],
      ['get_definition', { filePath: 'src/a.ts', line: 1, character: -1 }, false],
      ['get_definition', { symbolId: 'not-a-symbol' }, false],
      ['get_implementations', { symbolId: 'symbol_v1_1234567890123456789012345678901234567890123' }, true],
      ['get_references', { filePath: 'src/a.ts', line: 1, character: 0, maxResults: 1000 }, true],
      ['get_references', { filePath: 'src/a.ts', line: 1, character: 0, maxResults: 1001 }, false],
      ['get_references', { filePath: 'src/a.ts', line: 1, character: 0, maxResults: 0 }, false],
    ];
    for (const [name, args, expected] of cases) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      if (definition === undefined) throw new Error(`missing ${name}`);
      expect(z3.object(toZodV3Shape(definition.input)).safeParse(args).success).toBe(expected);
      expect(toZodV4Object(definition.input).safeParse(args).success).toBe(expected);
    }
    const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === 'get_definition');
    if (definition === undefined) throw new Error('missing get_definition');
    const v3 = z3.object(toZodV3Shape(definition.input)).parse({ filePath: 'src/a.ts', line: 2, character: 0 });
    const v4 = toZodV4Object(definition.input).parse({ filePath: 'src/a.ts', line: 2, character: 0 });
    expect(v4).toEqual(v3);
  });

  it('honours config-driven limit overrides', () => {
    const hybrid = TOOL_DEFINITIONS.find((definition) => definition.name === 'hybrid_search');
    if (hybrid === undefined) {
      throw new Error('hybrid_search definition is missing');
    }
    const schema = toZodV4Object(hybrid.input, { topK: 25, maxResults: 100 });
    expect(schema.safeParse({ query: 'auth', topK: 25 }).success).toBe(true);
    expect(schema.safeParse({ query: 'auth', topK: 26 }).success).toBe(false);
  });

  it('never lets a configured maxResults limit raise the get_references hard maximum', () => {
    const references = TOOL_DEFINITIONS.find((definition) => definition.name === 'get_references');
    const grep = TOOL_DEFINITIONS.find((definition) => definition.name === 'grep_search');
    if (references === undefined || grep === undefined) throw new Error('expected definitions are missing');
    const raised = { topK: 100, maxResults: 5000 };
    expect(toV2JsonSchema(references.input, raised)).toMatchObject({
      properties: { maxResults: { maximum: 1000 } },
    });
    const base = { filePath: 'src/a.ts', line: 1, character: 0 };
    expect(toZodV4Object(references.input, raised).safeParse({ ...base, maxResults: 1000 }).success).toBe(true);
    expect(toZodV4Object(references.input, raised).safeParse({ ...base, maxResults: 1001 }).success).toBe(false);
    // A lower configured limit still lowers it.
    const lowered = { topK: 100, maxResults: 50 };
    expect(toZodV4Object(references.input, lowered).safeParse({ ...base, maxResults: 51 }).success).toBe(false);
    // grep_search keeps its config-driven behavior.
    expect(toV2JsonSchema(grep.input, raised)).toMatchObject({ properties: { maxResults: { maximum: 5000 } } });
    expect(toZodV4Object(grep.input, raised).safeParse({ pattern: 'x', maxResults: 5000 }).success).toBe(true);
  });

  it('converts neutral schemas to SDK-compatible JSON Schema', () => {
    const hybrid = TOOL_DEFINITIONS.find((definition) => definition.name === 'hybrid_search');
    if (hybrid === undefined) {
      throw new Error('hybrid_search definition is missing');
    }
    expect(toV2JsonSchema(hybrid.input, { topK: 25, maxResults: 100 })).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        topK: { type: 'integer', minimum: 1, maximum: 25 },
      },
    });
  });
});

describe('v1/v2 schema parity', () => {

  it('applies default mode eager for get_context', () => {
    const getContext = TOOL_DEFINITIONS.find((definition) => definition.name === 'get_context');
    if (getContext === undefined) {
      throw new Error('get_context definition is missing');
    }
    const parsed = toZodV4Object(getContext.input).safeParse({ filePath: 'src/a.ts' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.mode).toBe('eager');
  });
});

describe('v2 integer minimum handling', () => {
  it('accepts zero only when the explicit minimum is zero', () => {
    const schema = toZodV4Object({ character: { kind: 'integer', minimum: 0 } });
    expect(schema.safeParse({ character: 0 }).success).toBe(true);
    expect(schema.safeParse({ character: 5 }).success).toBe(true);
    expect(schema.safeParse({ character: -1 }).success).toBe(false);
    expect(schema.safeParse({ character: 1.5 }).success).toBe(false);
  });

  it('keeps rejecting zero when no minimum is declared', () => {
    const schema = toZodV4Object({ line: { kind: 'integer' } });
    expect(schema.safeParse({ line: 0 }).success).toBe(false);
    expect(schema.safeParse({ line: 1 }).success).toBe(true);
  });

  it('keeps rejecting zero when the explicit minimum is one', () => {
    const schema = toZodV4Object({ line: { kind: 'integer', minimum: 1 } });
    expect(schema.safeParse({ line: 0 }).success).toBe(false);
    expect(schema.safeParse({ line: 1 }).success).toBe(true);
  });
});

describe('withErrorCode', () => {
  it('adds NEXUS_CONTENT_NOT_FOUND to classified error results', () => {
    const result = withErrorCode({
      content: [{ type: 'text', text: 'Error: ENOENT' }],
      isError: true,
      structuredContent: { error: true, message: 'ENOENT: no such file or directory' },
    });
    expect(result.structuredContent).toEqual({
      error: true,
      message: 'ENOENT: no such file or directory',
      code: 'NEXUS_CONTENT_NOT_FOUND',
    });
  });

  it('preserves non-error results by identity and classifies unknown errors', () => {
    const ok = { content: [{ type: 'text' as const, text: '{}' }], structuredContent: { results: [] } };
    const unknownError = {
      content: [{ type: 'text' as const, text: 'Error: boom' }],
      isError: true,
      structuredContent: { error: true, message: 'boom' },
    };
    expect(withErrorCode(ok)).toBe(ok);
    expect(withErrorCode(unknownError)).toEqual({
      ...unknownError,
      structuredContent: {
        error: true,
        message: 'boom',
        code: 'NEXUS_INTERNAL_ERROR',
      },
    });
  });
});

describe('v2 adapter over InMemoryTransport', () => {
  it('lists all tools and executes grep_search', async () => {
    const { Client } = await import('@modelcontextprotocol/client');
    const { InMemoryTransport, McpServer } = await import('@modelcontextprotocol/server');
    const { buildToolHandlers } = await import('../../../../../../src/server/tools/tool-support.js');
    const { registerV2Tools } = await import('../../../../../../src/server/tools/registry/adapters/v2-adapter.js');
    const { createTestNexusOptions } = await import('../../../../../shared/create-test-nexus-options.js');

    const { options } = await createTestNexusOptions();
    const server = new McpServer({ name: 'nexus', version: '0.1.0' });
    registerV2Tools(server, buildToolHandlers(options));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'v2-adapter-test-client', version: '0.1.0' });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual([
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

      const result = await client.callTool({ name: 'grep_search', arguments: { pattern: 'authenticate' } });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ matches: [{ filePath: expect.any(String) }] });

      const navigation = await client.callTool({
        name: 'get_references',
        arguments: { filePath: 'src/auth.ts', line: 1, character: 0 },
      });
      expect(navigation.isError).toBeUndefined();
      expect(navigation.structuredContent).toMatchObject({
        status: 'unavailable',
        capability: 'unavailable',
        reasonCode: 'LSP_NOT_CONFIGURED',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('defaults get_context to eager mode when mode is omitted', async () => {
    const { Client } = await import('@modelcontextprotocol/client');
    const { InMemoryTransport, McpServer } = await import('@modelcontextprotocol/server');
    const { buildToolHandlers } = await import('../../../../../../src/server/tools/tool-support.js');
    const { registerV2Tools } = await import('../../../../../../src/server/tools/registry/adapters/v2-adapter.js');
    const { createTestNexusOptions } = await import('../../../../../shared/create-test-nexus-options.js');

    const { options } = await createTestNexusOptions();
    options.loadFileContent = async (filePath: string) => {
      return `# README\n\nSample content for ${filePath}\n`;
    };
    const server = new McpServer({ name: 'nexus', version: '0.1.0' });
    registerV2Tools(server, buildToolHandlers(options));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'v2-adapter-test-client', version: '0.1.0' });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const result = await client.callTool({
        name: 'get_context',
        arguments: { filePath: 'README.md', startLine: 1, endLine: 3 },
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        filePath: expect.any(String),
        content: expect.any(String),
      });
      expect(result.structuredContent).not.toHaveProperty('mode');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('normalizes omitted mode to eager before invoking the handler', async () => {
    const { Client } = await import('@modelcontextprotocol/client');
    const { InMemoryTransport, McpServer } = await import('@modelcontextprotocol/server');
    const { registerV2Tools } = await import('../../../../../../src/server/tools/registry/adapters/v2-adapter.js');
    const { TOOL_DEFINITIONS } = await import('../../../../../../src/server/tools/registry/definitions.js');
    const receivedModes: (string | undefined)[] = [];
    const handlers: Record<string, ToolHandler> = Object.fromEntries(
      TOOL_DEFINITIONS.map((definition) => [
        definition.name,
        async (_args: unknown) => ({
          content: [{ type: 'text' as const, text: '' }],
          structuredContent: {},
        }),
      ]),
    );
    handlers.get_context = async (args: unknown) => {
      const parsed = args as { mode: string };
      receivedModes.push(parsed.mode);
      return {
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { mode: parsed.mode },
      };
    };

    const server = new McpServer({ name: 'nexus', version: '0.1.0' });
    registerV2Tools(server, handlers);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'v2-adapter-test-client', version: '0.1.0' });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const result = await client.callTool({
        name: 'get_context',
        arguments: { filePath: 'src/auth.ts', startLine: 1, endLine: 1 },
      });
      expect(result.isError).toBeUndefined();
      expect(receivedModes).toEqual(['eager']);
      expect(result.structuredContent).toEqual({ mode: 'eager' });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

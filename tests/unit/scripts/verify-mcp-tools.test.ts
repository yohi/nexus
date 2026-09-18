import { describe, expect, it } from 'vitest';

const verifier = await import('../../../scripts/verify-mcp-tools.mjs');

describe('MCP tool verification contracts', () => {
  it('accepts the current complete tool list', () => {
    expect(verifier.validateToolList([...verifier.EXPECTED_TOOL_NAMES])).toEqual({ ok: true });
  });

  it('reports a missing registered tool', () => {
    const names = verifier.EXPECTED_TOOL_NAMES.filter((name) => name !== 'get_symbol_context');

    expect(verifier.validateToolList(names)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('get_symbol_context'),
    });
  });

  it('accepts a grep result containing the fixture marker', () => {
    expect(verifier.validateToolResult('grep_search', {
      matches: [{ filePath: 'fixture.ts', lineText: 'allToolsNeedle' }],
    }, 'allToolsNeedle')).toEqual({ ok: true });
  });

  it('does not treat a cold-start structured index failure as a skip', () => {
    expect(verifier.validateToolResult('get_file_outline', {
      status: 'not_indexed',
      reasonCode: 'STRUCTURED_INDEX_MISSING',
    })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_indexed'),
    });
  });

  it('accepts successful structured retrieval responses containing the marker', () => {
    const outline = verifier.validateToolResult('get_file_outline', {
      status: 'ok',
      symbols: [{ symbolId: 'symbol-1' }],
    });
    const source = verifier.validateToolResult('get_symbol_source', {
      status: 'ok',
      source: 'return allToolsNeedle;',
    }, 'allToolsNeedle');
    const context = verifier.validateToolResult('get_symbol_context', {
      status: 'ok',
      context: 'return allToolsNeedle;',
    }, 'allToolsNeedle');

    expect(outline).toEqual({ ok: true });
    expect(source).toEqual({ ok: true });
    expect(context).toEqual({ ok: true });
  });
});

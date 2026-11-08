import { describe, expect, it } from 'vitest';

import {
  GET_CONTEXT_DEFINITION,
  REINDEX_DEFINITION,
  TOOL_DEFINITIONS,
} from '../../../../../src/server/tools/registry/definitions.js';

describe('tool definitions', () => {
  it('contains the 12 known tools in registration order', () => {
    expect(TOOL_DEFINITIONS.map((definition) => definition.name)).toEqual([
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
  });

  it('declares flat navigation target fields with maxResults only on get_references', () => {
    const target = {
      symbolId: { kind: 'string', optional: true, pattern: '^symbol_v1_[A-Za-z0-9_-]{43}$' },
      filePath: { kind: 'string', optional: true },
      line: { kind: 'integer', optional: true, minimum: 1 },
      character: { kind: 'integer', optional: true, minimum: 0 },
    };
    for (const name of ['get_definition', 'get_references', 'get_implementations']) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      expect(definition?.input).toMatchObject(target);
      expect(Object.keys(definition?.input ?? {})).toEqual(
        name === 'get_references'
          ? ['symbolId', 'filePath', 'line', 'character', 'maxResults']
          : ['symbolId', 'filePath', 'line', 'character'],
      );
    }
    const references = TOOL_DEFINITIONS.find((candidate) => candidate.name === 'get_references');
    expect(references?.input.maxResults).toMatchObject({ kind: 'integer', optional: true, minimum: 1, maximum: 1000 });
  });

  it('mirrors the legacy get_context schema', () => {
    expect(GET_CONTEXT_DEFINITION.input.mode).toEqual({
      kind: 'enum',
      values: ['eager', 'deferred'],
      optional: true,
      default: 'eager',
      description:
        'Set to "deferred" to receive a short preview and hint instead of full content for large files.',
    });
  });

  it('caps topK and maxResults with v2 maximums', () => {
    const hybrid = TOOL_DEFINITIONS.find((definition) => definition.name === 'hybrid_search');
    const grep = TOOL_DEFINITIONS.find((definition) => definition.name === 'grep_search');
    expect(hybrid?.input.topK).toMatchObject({ kind: 'integer', maximum: 100 });
    expect(grep?.input.maxResults).toMatchObject({ kind: 'integer', maximum: 1000 });
  });
  it('describes contextLines values above 20 as rejected', () => {
    const hybrid = TOOL_DEFINITIONS.find((definition) => definition.name === 'hybrid_search');
    expect(hybrid?.input.contextLines?.description).toContain('rejected');
    expect(hybrid?.input.contextLines?.description).not.toContain('clamped');
  });

  it('accepts reindex reasons at the tool boundary', () => {
    expect(REINDEX_DEFINITION.input.reason).toEqual({
      kind: 'enum',
      values: ['manual', 'overflow-recovery', 'startup-reconciliation'],
      optional: true,
    });
  });
});

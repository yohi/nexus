import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const verifier = await import('../../../scripts/verify-mcp-tools.mjs');

const runVerifier = (cwd: string): Promise<{ stdout: string; stderr: string; status: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'scripts/verify-mcp-tools.mjs'), '--json'], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ stdout, stderr, status }));
  });

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

  it('requires an indexed, error-free status response', () => {
    const healthy = {
      pipelineProgress: { status: 'idle' },
      indexStats: { lastIndexedAt: '2026-09-18T00:00:00.000Z', lastError: null },
      skippedFiles: 0,
    };

    expect(verifier.validateToolResult('index_status', healthy)).toEqual({ ok: true });
    expect(verifier.validateToolResult('index_status', {
      ...healthy,
      indexStats: { lastError: null },
    })).toMatchObject({ ok: false });
    expect(verifier.validateToolResult('index_status', {
      ...healthy,
      indexStats: { ...healthy.indexStats, lastIndexedAt: 'not-a-timestamp' },
    })).toMatchObject({ ok: false });
    expect(verifier.validateToolResult('index_status', {
      ...healthy,
      pipelineProgress: { status: 'idle', lastError: 'index failed' },
    })).toMatchObject({ ok: false });
    expect(verifier.validateToolResult('index_status', {
      ...healthy,
      indexStats: { ...healthy.indexStats, lastError: 'index failed' },
    })).toMatchObject({ ok: false });
    expect(verifier.validateToolResult('index_status', {
      ...healthy,
      skippedFiles: 1,
    })).toMatchObject({ ok: false });
  });

  it('requires reconciliation fields in a completed reindex response', () => {
    const complete = {
      startedAt: '2026-09-18T00:00:00.000Z',
      finishedAt: '2026-09-18T00:00:01.000Z',
      durationMs: 1000,
      reconciliation: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 2,
    };

    expect(verifier.validateToolResult('reindex', complete)).toEqual({ ok: true });
    expect(verifier.validateToolResult('reindex', {
      ...complete,
      reconciliation: { added: 1, modified: 0, deleted: 0 },
    })).toMatchObject({ ok: false });
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

  it('writes a sanitized JSON fatal summary to stdout in JSON mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nexus-verifier-test-'));
    try {
      const result = await runVerifier(cwd);

      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: expect.any(String) });
      expect(result.stdout).not.toContain(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

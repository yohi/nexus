import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolResult } from '../../../../src/server/tools/tool-support.js';
import { OutcomeCollector } from '../../../benchmarks/performance/outcomes.js';
import { runRetrievalCase, validateArguments } from '../../../benchmarks/performance/retrieval.js';
import { validateHandlerResponse } from '../../../benchmarks/performance/validate-response.js';
import { createRetrievalFixture, observedGrepHandler } from './retrieval-fixture.js';

const fixtures: Awaited<ReturnType<typeof createRetrievalFixture>>[] = [];
async function fixture() { const value = await createRetrievalFixture(); fixtures.push(value); return value; }
afterEach(async () => { await Promise.all(fixtures.splice(0).map((value) => value.dispose())); });

describe('handler-internal retrieval validity', () => {
  it('rejects invalid tool arguments during preflight', () => {
    expect(() => validateArguments('grep_search', { pattern: 42 })).toThrow();
  });

  it('rejects schema preflight before invoking a measured handler', async () => {
    const current = await fixture();
    const collector = new OutcomeCollector();
    let calls = 0;
    const record = await runRetrievalCase({ grep_search: () => { calls += 1; return Promise.resolve(toolResult({ matches: [] })); } },
      { ...current.query('grep-no-match'), args: { pattern: 42 } }, collector,
      { run: current.run, manifest: current.manifest, signal: new AbortController().signal, mode: 'warm' }, current.normalize);
    expect(record.status).toBe('invalid');
    expect(calls).toBe(0);
  });

  it('accepts a successful empty grep after five warmups and three smoke samples', async () => {
    const current = await fixture();
    const collector = new OutcomeCollector();
    const grep = observedGrepHandler(collector, []);
    let calls = 0;
    const record = await runRetrievalCase({ grep_search: () => { calls += 1; return grep(); } }, current.query('grep-no-match'), collector,
      { run: current.run, manifest: current.manifest, signal: new AbortController().signal, mode: 'warm' }, current.normalize);
    expect(record).toMatchObject({ status: 'valid', warmupCalls: 5, measuredCalls: 3,
      validation: { status: 'valid', resultCount: 0, grepProof: { status: 'valid', lineMatchCount: 0 } } });
    if (record.status === 'valid') expect(record.rawSamples).toHaveLength(3);
    expect(calls).toBe(8);
    expect(collector.pendingEvidenceCount).toBe(0);
  });

  it('validates every broad grep row beyond requested100 without benchmark truncation', async () => {
    const current = await fixture();
    const query = current.query('grep-broad');
    const matches = query.expectedMatches.map((row) => ({ filePath: join(current.root, row.path), lineNumber: row.line,
      lineText: '// perf_broad\n', submatches: [{ start: 3, end: 13, match: 'perf_broad' }] }));
    const collector = new OutcomeCollector();
    await collector.run('broad', async () => {
      const envelope = await observedGrepHandler(collector, matches)();
      const original = JSON.stringify(envelope);
      const validation = await validateHandlerResponse(query, envelope,
        { execution: await collector.seal('broad'), manifest: current.manifest, signal: new AbortController().signal }, current.normalize);
      expect(validation).toMatchObject({ status: 'valid', resultCount: 200, grepProof: { lineMatchCount: 200 } });
      expect(JSON.stringify(envelope)).toBe(original);
      expect(JSON.stringify(validation)).not.toContain(current.root);
    });
    collector.releaseAll();
  });

  it.each(['missing', 'extra', 'submatch'] as const)('rejects %s public grep rows despite successful measured branch evidence', async (mode) => {
    const current = await fixture();
    const query = current.query('grep-broad');
    const matches = query.expectedMatches.map((row) => ({ filePath: join(current.root, row.path), lineNumber: row.line,
      lineText: '// perf_broad\n', submatches: [{ start: 3, end: 13, match: 'perf_broad' }] }));
    const collector = new OutcomeCollector();
    await collector.run('corrupt', async () => {
      await observedGrepHandler(collector, matches)();
      const first = matches[0];
      if (first === undefined) throw new Error('match required');
      const logical = query.expectedMatches[0]?.path;
      if (logical === undefined) throw new Error('logical path required');
      const changed = mode === 'missing' ? matches.slice(1) : mode === 'extra' ? [...matches, { ...first, filePath: logical }]
        : [{ ...first, submatches: [] }, ...matches.slice(1)];
      const validation = await validateHandlerResponse(query, toolResult({ matches: changed }),
        { execution: await collector.seal('corrupt'), manifest: current.manifest, signal: new AbortController().signal }, current.normalize);
      expect(validation.status).toBe('invalid');
    });
    collector.releaseAll();
  });

  it.each(['stale', 'stale_identity', 'index_incomplete', 'not_indexed', 'not_found', 'excluded',
    'unsupported', 'failed', 'degraded', 'unexpected'] as const)('rejects Structured status %s on every Structured path', async (status) => {
    const current = await fixture();
    for (const id of ['structured-outline', 'structured-source', 'structured-context']) {
      const result = await validateHandlerResponse(current.query(id), toolResult({ status, freshness: 'unknown', reindexRequired: true }),
        { execution: { status: 'valid', failures: [], workCount: 1, workKinds: ['initialization'], grepExecution: [] },
          manifest: current.manifest, signal: new AbortController().signal }, current.normalize);
      expect(result.status).toBe('invalid');
    }
  });

  it('rejects partial Hybrid execution before trusting a plausible public response', async () => {
    const current = await fixture();
    const result = await validateHandlerResponse(current.query('hybrid-pre-fusion-125'), toolResult({ results: [] }),
      { execution: { status: 'invalid', failures: ['work_failed'], workCount: 1, workKinds: ['hybrid'], grepExecution: [] },
        manifest: current.manifest, signal: new AbortController().signal }, current.normalize);
    expect(result.status).toBe('invalid');
  });

  it('uses five unmeasured warmups and exactly100 full-mode calls per case', async () => {
    const current = await fixture();
    const collector = new OutcomeCollector();
    const grep = observedGrepHandler(collector, []);
    let calls = 0;
    const record = await runRetrievalCase({ grep_search: () => { calls += 1; return grep(); } }, current.query('grep-no-match'), collector,
      { run: { ...current.run, sampleMode: 'full' }, manifest: current.manifest, signal: new AbortController().signal, mode: 'warm' }, current.normalize);
    expect(record).toMatchObject({ status: 'valid', warmupCalls: 5, measuredCalls: 100 });
    if (record.status === 'valid') expect(record.rawSamples).toHaveLength(100);
    expect(calls).toBe(105);
    collector.releaseAll();
  });

  it('takes one first-call sample without warmup calls', async () => {
    const current = await fixture();
    const collector = new OutcomeCollector();
    const record = await runRetrievalCase({ grep_search: observedGrepHandler(collector, []) }, current.query('grep-no-match'), collector,
      { run: current.run, manifest: current.manifest, signal: new AbortController().signal, mode: 'first_call' }, current.normalize);
    expect(record).toMatchObject({ status: 'valid', warmupCalls: 0, measuredCalls: 1 });
    collector.releaseAll();
  });

  it('keeps a failed measured call invalid without silently retrying it', async () => {
    const current = await fixture();
    const collector = new OutcomeCollector();
    const grep = observedGrepHandler(collector, []);
    let calls = 0;
    const record = await runRetrievalCase({ grep_search: () => {
      calls += 1;
      return calls === 7 ? Promise.reject(new Error('/private/failed-call')) : grep();
    } }, current.query('grep-no-match'), collector,
    { run: current.run, manifest: current.manifest, signal: new AbortController().signal, mode: 'warm' }, current.normalize);
    expect(record).toMatchObject({ status: 'invalid', warmupCalls: 5, measuredCalls: 2, code: 'handler_exception' });
    expect(calls).toBe(7);
    expect(JSON.stringify(record)).not.toContain('/private');
    collector.releaseAll();
  });

  it('rejects broken public JSON text even when structured content and branch execution look successful', async () => {
    const current = await fixture();
    const collector = new OutcomeCollector();
    await collector.run('serialization', async () => {
      const envelope = await observedGrepHandler(collector, [])();
      const changed = { ...envelope, content: [{ type: 'text', text: 'not-json' }] };
      const result = await validateHandlerResponse(current.query('grep-no-match'), changed,
        { execution: await collector.seal('serialization'), manifest: current.manifest, signal: new AbortController().signal }, current.normalize);
      expect(result.status).toBe('invalid');
    });
    collector.releaseAll();
  });
});

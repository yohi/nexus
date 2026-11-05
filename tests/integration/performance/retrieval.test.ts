import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildToolHandlers, toolResult } from '../../../src/server/tools/tool-support.js';
import { captureReadiness } from '../../benchmarks/performance/readiness.js';
import { systemClock } from '../../benchmarks/performance/clock.js';
import { createFixturePathNormalizer } from '../../benchmarks/performance/logical-path.js';
import { runRetrievalCase } from '../../benchmarks/performance/retrieval.js';
import { validateHandlerResponse } from '../../benchmarks/performance/validate-response.js';
import { runOptionsSchema } from '../../benchmarks/performance/contracts.js';
import { ControlledClock, createLifecycleFixture } from './lifecycle-fixture.js';
import { expectedSymbolId } from '../../benchmarks/performance/audit-manifest.js';

const fixtures: Awaited<ReturnType<typeof createLifecycleFixture>>[] = [];
async function fixture() {
  const current = await createLifecycleFixture(); fixtures.push(current);
  const ready = await captureReadiness(current.factory, current.collector, current.manifest, systemClock, new AbortController().signal);
  if (ready.status !== 'valid') throw new Error('readiness required');
  const handlers = buildToolHandlers(ready.assembly.options, ready.assembly.runtime.initialize.bind(ready.assembly.runtime));
  const normalize = await createFixturePathNormalizer(current.root, current.manifest);
  const run = runOptionsSchema.parse({ profile: 'smoke', outputMode: 'stdout', revision: { commit: 'a'.repeat(40), dirty: true },
    timeoutMs: 30_000, auditPageSize: 512, cacheSeedBatchSize: 512, memoryLimitMb: 2_048, sampleMode: 'smoke' });
  return { ...current, ready, handlers, normalize, run };
}
afterEach(async () => { vi.restoreAllMocks(); for (const current of fixtures.splice(0)) await current.dispose(); });

describe('actual handler retrieval projections', () => {
  it('validates every manifest case through all six production handlers', async () => {
    const current = await fixture();
    for (const query of current.manifest.queries) {
      const record = await runRetrievalCase(current.handlers, query, current.collector,
        { run: current.run, manifest: current.manifest, signal: new AbortController().signal, mode: 'first_call' }, current.normalize);
      expect(record.status, `${query.id}: ${JSON.stringify(record.status === 'invalid' ? record.failures : [])}`).toBe('valid');
      expect(JSON.stringify(record)).not.toContain(current.root);
    }
  });

  it('keeps absolute grep and Hybrid raw envelopes unchanged while validating full125 versus final20', async () => {
    const current = await fixture();
    for (const id of ['grep-broad', 'hybrid-pre-fusion-125']) {
      const query = current.manifest.queries.find((item) => item.id === id);
      if (query === undefined) throw new Error('query required');
      await current.collector.run(id, async () => {
        const envelope = await current.handlers[query.tool](query.args);
        const original = JSON.stringify(envelope);
        if (query.tool === 'grep_search') {
          const payload = z.object({ matches: z.array(z.object({ filePath: z.string() })) }).parse(envelope.structuredContent);
          expect(payload.matches.some((match) => isAbsolute(match.filePath))).toBe(true);
        }
        const validation = await validateHandlerResponse(query, envelope,
          { execution: await current.collector.seal(id), manifest: current.manifest, signal: new AbortController().signal }, current.normalize);
        expect(validation.status).toBe('valid');
        if (validation.status === 'valid' && query.tool === 'hybrid_search') {
          expect(validation.resultCount).toBe(20);
          expect(validation.grepProof).toMatchObject({ status: 'valid', lineMatchCount: 125, submatchCount: 125 });
        }
        expect(JSON.stringify(envelope)).toBe(original);
        expect(JSON.stringify(validation)).not.toContain(current.root);
      });
    }
  });

  it('runs delayed path normalization only after the measured handler duration is captured', async () => {
    const current = await fixture();
    const clock = new ControlledClock();
    let finished = false;
    const query = current.manifest.queries.find((item) => item.id === 'grep-selective');
    if (query === undefined) throw new Error('query required');
    const record = await runRetrievalCase({ grep_search: async (args, extra) => {
      finished = false;
      const response = await current.handlers.grep_search(args, extra);
      clock.advance(7); finished = true; return response;
    } }, query, current.collector,
    { run: current.run, manifest: current.manifest, signal: new AbortController().signal, mode: 'warm', clock }, async (path) => {
      expect(finished).toBe(true); clock.advance(37); return current.normalize(path);
    });
    expect(record.status).toBe('valid');
    if (record.status === 'valid') expect(record.rawSamples).toEqual([7, 7, 7]);
  });

  it('invalidates an escaped Hybrid path despite successful real branch completion', async () => {
    const current = await fixture();
    const query = current.manifest.queries.find((item) => item.id === 'hybrid-pre-fusion-125');
    if (query === undefined) throw new Error('query required');
    await current.collector.run('escaped', async () => {
      const envelope = await current.handlers.hybrid_search(query.args);
      const payload = z.object({ results: z.array(z.object({ chunk: z.object({ filePath: z.string() }).passthrough() }).passthrough()) })
        .passthrough().parse(envelope.structuredContent);
      const changed = { ...payload, results: payload.results.map((item, index) => index === 0
        ? { ...item, chunk: { ...item.chunk, filePath: join(dirname(current.root), 'escaped-source.ts') } } : item) };
      const validation = await validateHandlerResponse(query, toolResult(changed),
        { execution: await current.collector.seal('escaped'), manifest: current.manifest, signal: new AbortController().signal }, current.normalize);
      expect(validation.status).toBe('invalid');
      expect(JSON.stringify(validation)).not.toContain('escaped-source.ts');
    });
  });

  it('uses a readiness probe distinct from the named first-call source workload', async () => {
    const current = await createLifecycleFixture(); fixtures.push(current);
    const requested: string[] = [];
    const factory = async (signal: AbortSignal) => {
      const assembly = await current.factory(signal);
      const service = assembly.options.symbolRetrievalService;
      if (service === undefined) throw new Error('symbol service required');
      const getSource = service.getSymbolSource.bind(service);
      vi.spyOn(service, 'getSymbolSource').mockImplementation((input) => {
        requested.push(input.symbolId); return getSource(input);
      });
      return assembly;
    };
    const ready = await captureReadiness(factory, current.collector, current.manifest, systemClock, new AbortController().signal);
    expect(ready.status).toBe('valid');
    const file = current.manifest.files[0];
    const declaration = file?.declarations[0];
    if (file === undefined || declaration === undefined) throw new Error('named workload required');
    expect(requested).toHaveLength(1);
    expect(requested[0]).not.toBe(expectedSymbolId(file, declaration.name));
  });

  it('rejects missing evidence outside final20 without losing the successful public top20', async () => {
    const current = await fixture();
    const capture = current.collector.captureGrepResults.bind(current.collector);
    vi.spyOn(current.collector, 'captureGrepResults').mockImplementation((context, matches) => capture(context, matches.slice(0, -1)));
    const query = current.manifest.queries.find((item) => item.id === 'hybrid-pre-fusion-125');
    if (query === undefined) throw new Error('query required');
    await current.collector.run('missing-branch', async () => {
      const envelope = await current.handlers.hybrid_search(query.args);
      expect(z.object({ results: z.array(z.unknown()) }).parse(envelope.structuredContent).results).toHaveLength(20);
      const validation = await validateHandlerResponse(query, envelope,
        { execution: await current.collector.seal('missing-branch'), manifest: current.manifest, signal: new AbortController().signal }, current.normalize);
      expect(validation.status).toBe('invalid');
    });
  });
});

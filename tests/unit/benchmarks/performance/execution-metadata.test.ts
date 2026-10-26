import { afterEach, describe, expect, it } from 'vitest';
import { OutcomeCollector } from '../../../benchmarks/performance/outcomes.js';
import { runRetrievalCase } from '../../../benchmarks/performance/retrieval.js';
import { summarizeCacheEvents } from '../../../benchmarks/performance/cache-accounting.js';
import { createRetrievalFixture, observedGrepHandler } from './retrieval-fixture.js';

const fixtures: Awaited<ReturnType<typeof createRetrievalFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

describe('preserved measurement metadata', () => {
  it('retains measured child wall/exit observations and requested/effective limits', async () => {
    const fixture = await createRetrievalFixture(); fixtures.push(fixture);
    const collector = new OutcomeCollector();
    const facts = await runRetrievalCase({ grep_search: observedGrepHandler(collector, []) }, fixture.query('grep-no-match'), collector,
      { run: fixture.run, manifest: fixture.manifest, signal: new AbortController().signal, mode: 'warm' }, fixture.normalize);
    expect(facts).toMatchObject({ status: 'valid', queryMetadata: { tool: 'grep_search', requestedMaximum: 100,
      limits: [{ stage: 'grep', behavior: 'uncapped' }] } });
    expect(facts).toHaveProperty('grepExecution');
    if ('grepExecution' in facts) {
      expect(facts.grepExecution).toHaveLength(3);
      expect(facts.grepExecution).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'exit_1', exitCode: 1 })]));
    }
    collector.releaseAll();
  });

  it('proves equal provider-input multisets independently of submitted order', () => {
    const identity = { time: 1, workId: 'batch' };
    const entries = [{ origin: 'legacy' as const, keyDigest: 'a'.repeat(64) },
      { origin: 'structured' as const, keyDigest: 'b'.repeat(64) }];
    const first = summarizeCacheEvents([{ ...identity, kind: 'embedding_batch_submitted', batchId: 'a', entries }]);
    const second = summarizeCacheEvents([{ ...identity, kind: 'embedding_batch_submitted', batchId: 'b', entries: entries.toReversed() }]);
    expect(first).toHaveProperty('providerInputMultisetDigest');
    if ('providerInputMultisetDigest' in first && 'providerInputMultisetDigest' in second) {
      expect(first.providerInputMultisetDigest).toBe(second.providerInputMultisetDigest);
    }
  });
});

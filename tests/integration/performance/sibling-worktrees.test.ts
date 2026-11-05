import { describe, expect, it } from 'vitest';
import { runSiblingScenarios } from '../../benchmarks/performance/sibling-scenarios.js';
import { runOptionsSchema } from '../../benchmarks/performance/contracts.js';
import { OutcomeCollector } from '../../benchmarks/performance/outcomes.js';

describe('independent disposable sibling worktrees', () => {
  it('indexes both real worktrees without cache sharing or user-repository commits', async () => {
    const run = runOptionsSchema.parse({ profile: 'smoke', outputMode: 'stdout', revision: { commit: 'a'.repeat(40), dirty: true },
      timeoutMs: 30_000, auditPageSize: 512, cacheSeedBatchSize: 512, memoryLimitMb: 2_048, sampleMode: 'smoke' });
    const collector = new OutcomeCollector();
    try {
      const records = await runSiblingScenarios('smoke', { run, collector, signal: new AbortController().signal, setupMs: 0 });
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.status)).toEqual(['valid', 'valid']);
      for (const record of records) {
        if (record.status !== 'valid') throw new Error('sibling readiness required');
        expect(record.cacheState).toBe('empty');
        expect(record.cacheAccounting?.providerCalls).toBeGreaterThan(0);
        expect(record.cacheAccounting?.outcomes.miss).toBeGreaterThan(0);
        expect(record.audit.counts).toMatchObject({ legacyRows: 120, structuredRows: 100, declarations: 100, imports: 20 });
      }
    } finally { collector.releaseAll(); }
  });
});

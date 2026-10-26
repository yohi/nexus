import { describe, expect, it } from 'vitest';
import type { NexusRuntime } from '../../../src/server/index.js';
import { captureReadiness } from '../../benchmarks/performance/readiness.js';
import { systemClock } from '../../benchmarks/performance/clock.js';
import { runFirstCallGroup } from '../../benchmarks/performance/first-call.js';
import { createBenchmarkRuntimeFactory } from '../../benchmarks/performance/runtime.js';
import { createFixturePathNormalizer } from '../../benchmarks/performance/logical-path.js';
import { runOptionsSchema } from '../../benchmarks/performance/contracts.js';
import { createLifecycleFixture } from './lifecycle-fixture.js';

describe('independent reopened first-call runtimes', () => {
  it('collects exactly three full-mode calls from three fresh runtime objects', async () => {
    const current = await createLifecycleFixture();
    try {
      const ready = await captureReadiness(current.factory, current.collector, current.manifest, systemClock, new AbortController().signal);
      if (ready.status !== 'valid') throw new Error('initial index required');
      await ready.assembly.runtime.close();
      const query = current.manifest.queries.find((item) => item.id === 'structured-source');
      if (query === undefined) throw new Error('query required');
      const normalize = await createFixturePathNormalizer(current.root, current.manifest);
      const run = runOptionsSchema.parse({ profile: 'smoke', outputMode: 'stdout', revision: { commit: 'a'.repeat(40), dirty: true },
        timeoutMs: 30_000, auditPageSize: 512, cacheSeedBatchSize: 512, memoryLimitMb: 2_048, sampleMode: 'full' });
      const runtimes = new Set<NexusRuntime>();
      const result = await runFirstCallGroup((collector) => {
        const factory = createBenchmarkRuntimeFactory(current.root, collector);
        return async (signal) => { const assembly = await factory(signal); runtimes.add(assembly.runtime); return assembly; };
      }, query, { run, manifest: current.manifest, signal: new AbortController().signal }, normalize);
      expect(result.status).toBe('valid');
      expect(runtimes.size).toBe(3);
      if (result.status === 'valid') {
        expect(result.rawSamples).toHaveLength(3);
        expect(result.readiness).toHaveLength(3);
        expect(result.warmupCalls).toBe(0);
      }
    } finally { await current.dispose(); }
  });
});

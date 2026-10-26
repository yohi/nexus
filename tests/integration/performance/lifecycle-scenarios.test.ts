import { afterEach, describe, expect, it, vi } from 'vitest';
import { runExistingRuntimeScenario, runStartupScenario } from '../../benchmarks/performance/lifecycle.js';
import { captureReadiness } from '../../benchmarks/performance/readiness.js';
import { systemClock } from '../../benchmarks/performance/clock.js';
import { runOptionsSchema } from '../../benchmarks/performance/contracts.js';
import { createCacheSeedTarget, seedCompatibleCache } from '../../benchmarks/performance/cache-seed.js';
import { createBenchmarkRuntimeFactory } from '../../benchmarks/performance/runtime.js';
import { generateFixture } from '../../benchmarks/performance/fixtures.js';
import { syntheticEmbeddingConfig } from '../../benchmarks/performance/synthetic-provider.js';
import { OutcomeCollector } from '../../benchmarks/performance/outcomes.js';
import { createLifecycleFixture } from './lifecycle-fixture.js';

const fixtures: Awaited<ReturnType<typeof createLifecycleFixture>>[] = [];
async function fixture() { const value = await createLifecycleFixture(); fixtures.push(value); return value; }
afterEach(async () => { vi.restoreAllMocks(); for (const value of fixtures.splice(0)) await value.dispose(); });
const run = runOptionsSchema.parse({ profile: 'smoke', outputMode: 'stdout', revision: { commit: 'a'.repeat(40), dirty: true },
  timeoutMs: 30_000, auditPageSize: 512, cacheSeedBatchSize: 512, memoryLimitMb: 2_048, sampleMode: 'smoke' });

describe('actual lifecycle scenario records', () => {
  it('returns construction-to-ready samples and closes startup-only runtimes', async () => {
    const current = await fixture();
    const record = await runStartupScenario('cold_initial_index', current.factory, current.manifest,
      { run, collector: current.collector, signal: new AbortController().signal, setupMs: 0 });
    expect(record).toMatchObject({ status: 'valid', boundary: 'runtime-assembly-to-ready', cacheState: 'empty', sampleKind: 'lifecycle' });
    if (record.status === 'valid') {
      expect(record.rawSamples).toHaveLength(1);
      expect(record.endpoints.benchmark_completion_ms).toBeGreaterThanOrEqual(record.endpoints.audited_ready_ms ?? 0);
      expect(record.resources.node_worker.cpuScope).toBe('runtime_to_completion');
    }
    const reopened = await current.factory(new AbortController().signal);
    await reopened.runtime.close();
  });

  it('measures same-process L1 replay as an operation without a fabricated readiness time', async () => {
    const current = await fixture();
    const ready = await captureReadiness(current.factory, current.collector, current.manifest, systemClock, new AbortController().signal);
    if (ready.status !== 'valid') throw new Error('readiness required');
    const record = await runExistingRuntimeScenario('l1_replay', ready.assembly, current.manifest,
      { run, collector: current.collector, signal: new AbortController().signal, setupMs: 0 });
    expect(record.status, record.status === 'invalid' ? JSON.stringify(record.failures) : '').toBe('valid');
    expect(record).toMatchObject({ status: 'valid', boundary: 'indexing-operation', cacheState: 'l1', indexingMode: 'full_rebuild' });
    if (record.status === 'valid') {
      expect(record.endpoints).not.toHaveProperty('runtime_ready_ms');
      expect(record.cacheAccounting?.outcomes.l1_hit).toBeGreaterThan(0);
      expect(record.cacheAccounting?.providerCalls).toBe(0);
      expect(ready.assembly.diagnostics.metadataStore.getPragmaValue('user_version')).toBeTypeOf('number');
    }
  });

  it('submits incremental add/modify/delete through the real queue and audits the post-change manifest', async () => {
    const current = await fixture();
    const ready = await captureReadiness(current.factory, current.collector, current.manifest, systemClock, new AbortController().signal);
    if (ready.status !== 'valid') throw new Error('readiness required');
    const record = await runExistingRuntimeScenario('incremental', ready.assembly, current.manifest,
      { run, collector: current.collector, signal: new AbortController().signal, setupMs: 0 });
    expect(record).toMatchObject({ status: 'valid', boundary: 'indexing-operation' });
    if (record.status === 'valid') {
      expect(record.endpoints).not.toHaveProperty('runtime_ready_ms');
      expect(record.audit.counts).toMatchObject({ legacyRows: 120, structuredRows: 100, declarations: 100, imports: 20 });
    }
  });

  it('proves L2 rebuild hits from a fully verified seed without copying catalog or Merkle state', async () => {
    const current = await fixture();
    const ready = await captureReadiness(current.factory, current.collector, current.manifest, systemClock, new AbortController().signal);
    if (ready.status !== 'valid') throw new Error('readiness required');
    const target = await createCacheSeedTarget();
    const collector = new OutcomeCollector();
    try {
      const manifest = await generateFixture(target.projectRoot, 'smoke');
      const seeded = await seedCompatibleCache({ metadataStore: ready.assembly.diagnostics.metadataStore,
        databasePath: ready.assembly.diagnostics.metadataDbPath, embeddingConfig: syntheticEmbeddingConfig },
      target, manifest, new AbortController().signal);
      expect(seeded.status).toBe('valid');
      expect(await target.metadataStore.getAllFileNodes()).toEqual([]);
      expect((await target.metadataStore.getStructuredCounts()).activeFiles).toBe(0);
      await ready.assembly.runtime.close();
      await target.metadataStore.close();
      const factory = createBenchmarkRuntimeFactory(target.projectRoot, collector);
      const record = await runStartupScenario('l2_rebuild', factory, manifest,
        { run, collector, signal: new AbortController().signal, setupMs: 0, cacheSeed: seeded });
      expect(record).toMatchObject({ status: 'valid', cacheState: 'l2' });
      if (record.status === 'valid') {
        expect(record.cacheAccounting?.outcomes.l2_hit).toBeGreaterThan(0);
        expect(record.cacheAccounting?.outcomes.miss).toBe(0);
        expect(record.cacheAccounting?.providerCalls).toBe(0);
      }
    } finally { collector.releaseAll(); await target.dispose(); }
  });

  it('rejects a nominal cold scenario if the expected empty-cache work was not exercised', async () => {
    const current = await fixture();
    const first = await captureReadiness(current.factory, current.collector, current.manifest, systemClock, new AbortController().signal);
    if (first.status !== 'valid') throw new Error('readiness required');
    await first.assembly.runtime.close();
    const record = await runStartupScenario('cold_initial_index', current.factory, current.manifest,
      { run, collector: current.collector, signal: new AbortController().signal, setupMs: 0 });
    expect(record.status).toBe('invalid');
  });

  it('invalidates a startup whose scenario deadline expires during cleanup', async () => {
    const current = await fixture();
    const controller = new AbortController();
    const factory = async (signal: AbortSignal) => {
      const assembly = await current.factory(signal);
      const close = assembly.runtime.close.bind(assembly.runtime);
      assembly.runtime.close = async () => { await close(); controller.abort(); };
      return assembly;
    };
    const record = await runStartupScenario('cold_initial_index', factory, current.manifest,
      { run, collector: current.collector, signal: controller.signal, setupMs: 0 });
    expect(record.status).toBe('invalid');
  });

  it('does not construct a nominal warm runtime after cache-seed setup failed', async () => {
    const current = await fixture();
    const factory = vi.fn(current.factory);
    const record = await runStartupScenario('l2_rebuild', factory, current.manifest,
      { run, collector: current.collector, signal: new AbortController().signal, setupMs: 1,
        cacheSeed: { status: 'invalid', phase: 'setup', code: 'cache_seed_failed', expectedKeyCount: 1,
          verifiedKeyCount: 0, batchLimit: 512, maxRequestedBatchSize: 0, durationMs: 1 } });
    expect(record).toMatchObject({ status: 'invalid', phase: 'setup' });
    expect(factory).not.toHaveBeenCalled();
  });
});

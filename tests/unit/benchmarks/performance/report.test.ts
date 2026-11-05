import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarizeLifecycle, summarizeWarm } from '../../../benchmarks/performance/statistics.js';
import { captureResources, measureIndexArtifacts } from '../../../benchmarks/performance/resources.js';
import { buildReport } from '../../../benchmarks/performance/report.js';
import { reportSchema, runOptionsSchema, scenarioRecordSchema } from '../../../benchmarks/performance/contracts.js';
import { profiles } from '../../../benchmarks/performance/profiles.js';
import { workloadSchema } from '../../../benchmarks/performance/workload.js';

const options = runOptionsSchema.parse({ profile: 'small', outputMode: 'stdout', revision: { commit: 'a'.repeat(40), dirty: true },
  timeoutMs: 120_000, auditPageSize: 512, cacheSeedBatchSize: 512, memoryLimitMb: 2_048, sampleMode: 'full' });
function metadata(run = options) {
  const scale = profiles[run.profile];
  const declarations = scale.files * scale.declarationsPerFile;
  return { runId: '00000000-0000-4000-8000-000000000000', fixtureDigest: 'a'.repeat(64), options: run,
    workload: workloadSchema.parse({ recipeVersion: 'retrieval-performance-v1', digest: 'a'.repeat(64), files: scale.files, utf8Bytes: 10_000,
      declarations, imports: scale.files, legacyRows: declarations + scale.files, structuredRows: declarations,
      provider: 'test', model: 'nexus-synthetic-sha256-v1', dimensions: 128, maxChunkChars: 4096 }),
    environment: { node: process.version, os: 'unit-os', architecture: process.arch, cpuModel: 'unit-cpu',
      cpuCount: 1, memoryBytes: 1_024, rgVersion: 'unit-rg', gitVersion: 'unit-git', osCache: 'uncontrolled' as const } };
}
function record(id: string, samples: readonly number[], kind: 'warm' | 'lifecycle' | 'first_call' = 'warm', sampleMode: 'smoke' | 'full' = 'full') {
  const scale = profiles[sampleMode === 'smoke' ? 'smoke' : 'small'];
  const declarations = scale.files * scale.declarationsPerFile;
  return scenarioRecordSchema.parse({ id, status: 'valid', revision: options.revision,
    boundary: kind === 'lifecycle' ? 'runtime-assembly-to-ready' : 'handler-internal', cacheState: 'persisted',
    sampleMode, memoryLimitMb: 2_048, rawSamples: samples, sampleKind: kind, resources: captureResources(),
    endpoints: { setup_ms: 0 }, audit: { status: 'valid', durationMs: 0, counts: { legacyRows: declarations + scale.files,
      legacyFiles: scale.files, structuredRows: declarations, structuredFiles: scale.files, declarations,
      imports: scale.files, legacyGetStats: declarations + scale.files } },
    validation: { status: 'valid', resultCount: 0, identities: [] } });
}

describe('versioned performance reports', () => {
  it('nearest_rank_100_samples', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(summarizeWarm(samples)).toMatchObject({ p50: 50, p95: 95, p99: 99 });
    expect(samples[0]).toBe(1);
    expect(() => summarizeWarm([])).toThrow();
  });

  it.each([{ samples: [] }, { samples: [-1] }, { samples: [NaN] }, { samples: [Infinity] }, { samples: [-Infinity] }])('rejects invalid samples %j', ({ samples }) => {
    expect(() => summarizeWarm(samples)).toThrow();
    expect(() => summarizeLifecycle(samples)).toThrow();
  });

  it('reports lifecycle raw/min/median/max without tail fields', () => {
    const summary = summarizeLifecycle([30, 10, 20]);
    expect(summary).toEqual({ raw: [30, 10, 20], min: 10, median: 20, max: 30 });
    expect(summary).not.toHaveProperty('p95');
    expect(summary).not.toHaveProperty('p99');
  });

  it('excludes invalid records from normal summary statistics', () => {
    const valid = record('valid_case', Array.from({ length: 100 }, (_, index) => index + 1));
    const invalid = { id: 'failed_case', status: 'invalid', revision: options.revision, boundary: 'handler-internal',
      cacheState: 'empty', sampleMode: 'full', memoryLimitMb: 2_048, phase: 'retrieval', elapsedMs: 99_999,
      failures: [{ code: 'injected_failure', count: 1, examples: [] }] };
    const report = buildReport([valid, invalid], metadata());
    expect(report.status).toBe('incomplete');
    expect(report.summaries).toHaveLength(1);
    expect(report.summaries[0]).toMatchObject({ id: 'valid_case', kind: 'warm', p50: 50, p95: 95, p99: 99 });
  });

  it('combines only independent runs of the same lifecycle case', () => {
    const report = buildReport([record('cold_initial_index', [10], 'lifecycle'),
      record('cold_initial_index', [30], 'lifecycle'), record('cold_initial_index', [20], 'lifecycle')], metadata());
    expect(report.summaries).toEqual([{ id: 'cold_initial_index', kind: 'lifecycle', raw: [10, 30, 20], min: 10, median: 20, max: 30 }]);
  });

  it('labels smoke as non-baseline and does not present three calls as tail latency', () => {
    const smoke = runOptionsSchema.parse({ ...options, profile: 'smoke', sampleMode: 'smoke' });
    const report = buildReport([record('smoke_case', [1, 2, 3], 'warm', 'smoke')], metadata(smoke));
    expect(report.warnings).toContain('smoke_not_baseline');
    expect(report.warnings).toContain('smoke_no_tail_latency');
    expect(report.summaries.every((summary) => !('p95' in summary) && !('p99' in summary))).toBe(true);
  });

  it('captures measured numeric Node resources and explicit unavailable external scopes', () => {
    const resources = captureResources();
    expect(resources.node_worker.heapUsedBytes).toBeTypeOf('number');
    expect(resources.node_worker.rssBytes).toBeGreaterThan(0);
    expect(resources.node_worker.lifetimePeakRssBytes).toBeGreaterThan(0);
    expect(resources.external_ripgrep).toEqual({ status: 'not_collected' });
    expect(resources.process_tree).toEqual({ status: 'not_collected' });
  });

  it('measures settled metadata and vector apparent bytes outside runtime timers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-artifact-bytes-'));
    try {
      const metadataDbPath = join(root, 'metadata.db');
      const vectorDbPath = join(root, 'vectors');
      await mkdir(vectorDbPath);
      await writeFile(metadataDbPath, Buffer.alloc(123));
      await writeFile(join(vectorDbPath, 'one'), Buffer.alloc(200));
      await writeFile(join(vectorDbPath, 'two'), Buffer.alloc(300));
      expect(await measureIndexArtifacts({ metadataDbPath, vectorDbPath }, new AbortController().signal))
        .toEqual({ metadataBytes: 123, vectorBytes: 500, totalBytes: 623, measurement: 'apparent_bytes', phase: 'settled' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['rawEnvelope', 'rawChunkId', 'errorMessage'] as const)('rejects unsafe extra report payload %s without echoing it', (field) => {
    const unsafe = { ...record('unsafe_case', Array.from({ length: 100 }, () => 1)),
      [field]: '/private/fixture/sk-test-secret' };
    let failure: unknown;
    try { buildReport([unsafe], metadata()); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).not.toContain('/private');
      expect(failure.message).not.toContain('sk-test-secret');
    }
  });

  it('round-trips schemaVersion1 without leaking non-JSON runtime objects', () => {
    const report = buildReport([record('valid_case', Array.from({ length: 100 }, (_, index) => index))], metadata());
    expect(reportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
    expect(report.schemaVersion).toBe(1);
  });

  it('rejects a nominally valid audit whose counts disagree with the workload identity', () => {
    const valid = record('valid_case', Array.from({ length: 100 }, () => 1));
    if (valid.status !== 'valid') throw new Error('valid fixture required');
    const changed = { ...valid, audit: { ...valid.audit, counts: { ...valid.audit.counts, structuredRows: 0 } } };
    expect(() => buildReport([changed], metadata())).toThrow('invalid_report_data');
  });
});

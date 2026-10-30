import { Query } from '@lancedb/lancedb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { auditRuntime } from '../../benchmarks/performance/audit.js';
import { createSyntheticProvider } from '../../benchmarks/performance/synthetic-provider.js';
import { createAuditFixture, faultChunk, nativeFixturePath } from './audit-fixture.js';
import { createTraceRecorder } from '../../benchmarks/performance/diagnostics/trace-recorder.js';
import { createRuntimeDiagnosticContext } from '../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { withRuntimeDiagnosticContext } from '../../../src/observability/diagnostic-stage-trace.js';
import type { VectorAuditRow } from '../../../src/storage/interfaces/vector-audit.js';

const fixtures: Awaited<ReturnType<typeof createAuditFixture>>[] = [];
function createDiagnosticContext() {
  const workerContext = {
    recorder: createTraceRecorder({
      runId: '00000000-0000-4000-8000-000000000001',
      jobId: 'cold_initial_index',
      recipeDigest: 'a'.repeat(64),
      sourceFingerprint: 'b'.repeat(64),
      pid: 3002,
      processStartTicks: '4567',
      ppid: 2000,
      processRole: 'vitest_worker',
      clockDomain: 'process_local_monotonic',
    }, { nowNs: () => process.hrtime.bigint() }),
    operationId: 'op_0000000000000001',
    attemptId: 'attempt_1',
  };
  return { workerContext, runtimeContext: createRuntimeDiagnosticContext(workerContext) };
}

async function fixture() {
  const value = await createAuditFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((value) => value.close()));
});
const signal = (): AbortSignal => new AbortController().signal;

describe('streaming per-path physical audit', () => {
  it('audits legacy imports separately from structured declarations and active vectors', async () => {
    const current = await fixture();
    const result = await auditRuntime(current.assembly.diagnostics, current.manifest, signal());
    expect(result).toMatchObject({ status: 'valid', counts: { legacyRows: 120, legacyFiles: 20,
      structuredRows: 100, structuredFiles: 20, declarations: 100, imports: 20, legacyGetStats: 120 } });
    expect(JSON.stringify(result)).not.toContain(current.root);
    expect(JSON.stringify(result)).not.toContain('fault-injected');
  });

  it('records audit row and catalog progress without changing the audit result', async () => {
    const current = await fixture();
    const { workerContext, runtimeContext } = createDiagnosticContext();

    const result = await withRuntimeDiagnosticContext(runtimeContext, () =>
      auditRuntime(current.assembly.diagnostics, current.manifest, signal()));

    const trace = workerContext.recorder.snapshot().events;
    const counters = trace.filter((event) => event.event === 'progress');
    expect(result.status).toBe('valid');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'audit.rows_seen', value: 220 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'audit.rows_verified', value: 220 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'audit.catalog_files_attempted', value: 20 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'audit.catalog_files_verified', value: 20 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'audit.declarations_verified', value: 100 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'audit.imports_verified', value: 20 }));
    expect(JSON.stringify(trace)).not.toContain(current.root);
  });

  it('records bounded validation failures for invalid audit evidence', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    const row = file?.legacyRows[0];
    if (file === undefined || row === undefined) throw new Error('row required');
    const chunk = { ...faultChunk(file, row), hash: '0'.repeat(16) };
    await current.assembly.diagnostics.vectorStore.upsertChunks([chunk], await createSyntheticProvider().embed([chunk.content]));
    const { workerContext, runtimeContext } = createDiagnosticContext();

    const result = await withRuntimeDiagnosticContext(runtimeContext, () =>
      auditRuntime(current.assembly.diagnostics, current.manifest, signal()));

    expect(result.status).toBe('invalid');
    const counters = workerContext.recorder.snapshot().events.filter((event) => event.event === 'progress');
    expect(counters.some((event) => event.counterId === 'audit.validation_failures' && event.value > 0)).toBe(true);
  });

  it('flushes audit row progress at each 512-row boundary', async () => {
    const current = await fixture();
    const vectorStore = current.assembly.diagnostics.vectorStore;
    const originalIterate = vectorStore.iterateAuditRows.bind(vectorStore);
    const sourceRows: VectorAuditRow[] = [];
    for await (const row of originalIterate({ pageSize: 512, signal: signal() })) sourceRows.push(row);
    if (sourceRows.length === 0) throw new Error('fixture rows required');
    vi.spyOn(vectorStore, 'iterateAuditRows').mockImplementation(async function* () {
      for (let index = 0; index < 513; index += 1) {
        const row = sourceRows[index % sourceRows.length];
        if (row !== undefined) yield row;
      }
      await Promise.resolve();
    });
    const { workerContext, runtimeContext } = createDiagnosticContext();

    await withRuntimeDiagnosticContext(runtimeContext, () => auditRuntime(current.assembly.diagnostics, current.manifest, signal()));

    const counters = workerContext.recorder.snapshot().events.filter((event) => event.event === 'progress');
    const seenValues = counters.filter((event) => event.counterId === 'audit.rows_seen').map((event) => event.value);
    expect(seenValues).toContain(512);
    expect(seenValues).toContain(513);
  });

  it('pages real live rows without projecting source text or vectors', async () => {
    const current = await fixture();
    const limit = vi.spyOn(Query.prototype, 'limit');
    const select = vi.spyOn(Query.prototype, 'select');
    const rows: unknown[] = [];
    for await (const row of current.assembly.diagnostics.vectorStore.iterateAuditRows({ pageSize: 17, signal: signal() })) rows.push(row);
    expect(rows).toHaveLength(220);
    expect(limit.mock.calls.length).toBeGreaterThan(2);
    expect(limit.mock.calls.every(([size]) => size > 0 && size <= 17)).toBe(true);
    for (const [columns] of select.mock.calls) {
      const projection = z.array(z.string()).parse(columns);
      expect(projection).not.toContain('vector');
      expect(projection).not.toContain('content');
    }
    expect(JSON.stringify(rows)).not.toContain('"vector":');
    expect(JSON.stringify(rows)).not.toContain('"content":');
  });

  it('rejects a missing physical legacy file even when catalog declarations remain complete', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    if (file === undefined) throw new Error('file required');
    await current.assembly.diagnostics.vectorStore.deleteByFilePath(nativeFixturePath(file.path));
    expect((await auditRuntime(current.assembly.diagnostics, current.manifest, signal())).status).toBe('invalid');
  });

  it('detects duplicate active rows by physical multiplicity rather than global counts alone', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    const row = file?.structuredRows[0];
    if (file === undefined || row === undefined) throw new Error('row required');
    const chunk = faultChunk(file, row);
    const store = current.assembly.diagnostics.vectorStore;
    await store.stageGenerationChunks({ filePath: chunk.filePath, generationId: file.sourceHash,
      chunks: [chunk], vectors: await createSyntheticProvider().embed([chunk.content]) });
    await store.activateGenerationRows(chunk.filePath, file.sourceHash);
    const result = await auditRuntime(current.assembly.diagnostics, current.manifest, signal());
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.failures.map((failure) => failure.code)).toContain('duplicate_vector_row');
  });

  it('detects a wrong stored chunk hash', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    const row = file?.legacyRows[0];
    if (file === undefined || row === undefined) throw new Error('row required');
    const chunk = { ...faultChunk(file, row), hash: '0'.repeat(16) };
    await current.assembly.diagnostics.vectorStore.upsertChunks([chunk], await createSyntheticProvider().embed([chunk.content]));
    const result = await auditRuntime(current.assembly.diagnostics, current.manifest, signal());
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.failures.map((failure) => failure.code)).toContain('vector_hash_mismatch');
  });

  it('rejects active vectors belonging to the wrong generation', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    const row = file?.structuredRows[0];
    if (file === undefined || row === undefined) throw new Error('row required');
    const chunk = faultChunk(file, row);
    const store = current.assembly.diagnostics.vectorStore;
    await store.stageGenerationChunks({ filePath: chunk.filePath, generationId: 'foreign-generation',
      chunks: [chunk], vectors: await createSyntheticProvider().embed([chunk.content]) });
    await store.activateGenerationRows(chunk.filePath, 'foreign-generation');
    expect((await auditRuntime(current.assembly.diagnostics, current.manifest, signal())).status).toBe('invalid');
  });

  it('rejects unexpected active files without serializing their unvalidated identities', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    const row = file?.legacyRows[0];
    if (file === undefined || row === undefined) throw new Error('row required');
    const chunk = { ...faultChunk(file, row), id: 'unexpected.ts:1-1:extra', filePath: 'unexpected.ts' };
    await current.assembly.diagnostics.vectorStore.upsertChunks([chunk], await createSyntheticProvider().embed([chunk.content]));
    const result = await auditRuntime(current.assembly.diagnostics, current.manifest, signal());
    expect(result.status).toBe('invalid');
    expect(JSON.stringify(result)).not.toContain('unexpected.ts');
  });

  it('rejects pending catalog generations', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    if (file === undefined) throw new Error('file required');
    current.mutateCatalog((database) => {
      database.prepare('UPDATE structured_files SET pending_generation = ? WHERE file_path = ?')
        .run('pending-generation', nativeFixturePath(file.path));
    });
    expect((await auditRuntime(current.assembly.diagnostics, current.manifest, signal())).status).toBe('invalid');
  });

  it('rejects deleted active vector rows even with matching active catalog generations', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    if (file === undefined) throw new Error('file required');
    await current.assembly.diagnostics.vectorStore.removeGenerationRows(nativeFixturePath(file.path), file.sourceHash);
    expect((await auditRuntime(current.assembly.diagnostics, current.manifest, signal())).status).toBe('invalid');
  });

  it('treats catalog read failure as invalid evidence and redacts the raw error path', async () => {
    const current = await fixture();
    vi.spyOn(current.assembly.diagnostics.metadataStore, 'getFileDeclarations').mockRejectedValueOnce(new Error(current.root));
    const result = await auditRuntime(current.assembly.diagnostics, current.manifest, signal());
    expect(result.status).toBe('invalid');
    expect(JSON.stringify(result)).not.toContain(current.root);
  });

  it('reads the real DLQ instead of inferring completeness from index status', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    if (file === undefined) throw new Error('file required');
    await current.assembly.diagnostics.metadataStore.upsertDeadLetterEntries([{ id: 'injected-dlq',
      filePath: nativeFixturePath(file.path), contentHash: file.merkleHash, errorMessage: 'injected', attempts: 1,
      recoveryAttempts: 0, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', lastRetryAt: null }]);
    expect((await auditRuntime(current.assembly.diagnostics, current.manifest, signal())).status).toBe('invalid');
  });

  it('does not count retired tombstones as active symbols', async () => {
    const current = await fixture();
    current.mutateCatalog((database) => {
      database.prepare('INSERT INTO symbol_tombstones (symbol_id,file_path,generation,retired_at_rebuild_epoch,retired_at) VALUES (?,?,?,?,?)')
        .run('symbol_v1_retired', 'retired.ts', 'retired-generation', 0, 1);
    });
    expect((await auditRuntime(current.assembly.diagnostics, current.manifest, signal())).status).toBe('valid');
  });

  it('does not admit an audit cancelled before it can complete', async () => {
    const current = await fixture();
    const result = await auditRuntime(current.assembly.diagnostics, current.manifest, AbortSignal.abort());
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.failures.map((failure) => failure.code)).toContain('audit_aborted');
  });

  it('rejects concurrent mutation detected by before/after revisions', async () => {
    const current = await fixture();
    let revision = 0;
    const reader = { ...current.assembly.diagnostics, stateRevision: () => revision++ };
    expect((await auditRuntime(reader, current.manifest, signal())).status).toBe('invalid');
  });
});

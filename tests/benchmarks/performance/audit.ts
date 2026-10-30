import type { RuntimeDiagnostics } from '../../../src/server/runtime/assembly-types.js';
import { auditResultSchema } from './contracts.js';
import type { AuditResult, FixtureManifest } from './contracts.js';
import { AuditFailures, createAuditCounts } from './audit-failures.js';
import { AuditMembership, physicalFixturePath } from './audit-manifest.js';
import { auditCatalog } from './audit-catalog.js';
import { incrementRuntimeDiagnosticCounter, runRuntimeDiagnosticStage } from '../../../src/observability/diagnostic-stage-trace.js';

export function auditRuntime(reader: RuntimeDiagnostics, manifest: FixtureManifest,
  signal: AbortSignal): Promise<AuditResult> {
  return runRuntimeDiagnosticStage('S10_manifest_audit', () => auditRuntimeUnstaged(reader, manifest, signal));
}

async function auditRuntimeUnstaged(reader: RuntimeDiagnostics, manifest: FixtureManifest,
  signal: AbortSignal): Promise<AuditResult> {
  const started = performance.now();
  const counts = createAuditCounts();
  const failures = new AuditFailures(manifest);
  const revision = reader.stateRevision();
  const membership = new AuditMembership(manifest, failures);
  try {
    signal.throwIfAborted();
    const queue = reader.queueSnapshot();
    if (queue.size !== 0 || queue.postScanSize !== 0 || queue.dropped !== 0 || queue.state !== 'normal' ||
      queue.postScanActive || reader.pendingDrainCount() !== 0) failures.add('runtime_not_settled');
    const stats = await reader.metadataStore.getIndexStats();
    if (stats?.lastIndexedAt === null || stats === null || !Number.isFinite(Date.parse(stats.lastIndexedAt))) {
      failures.add('index_stats_missing');
    }
    if (stats?.lastError) failures.add('persisted_index_error');
    const state = await reader.metadataStore.getStructuredIndexState();
    if (state.schemaVersion !== 1 || state.rebuildState !== 'idle' || state.lastErrorCode !== null || state.reindexRequired ||
      state.counts.pendingFiles !== 0 || state.counts.pendingSymbols !== 0) failures.add('catalog_state_invalid');
    const expectedPaths = new Map(manifest.files.map((file) => [physicalFixturePath(file.path), file]));
    for (const [path, generation] of state.activeGenerations) {
      const file = expectedPaths.get(path);
      if (file === undefined) failures.add('unexpected_active_file');
      else if (generation !== file.sourceHash) failures.add('catalog_generation_mismatch', 1, file.path);
    }
    const expectedDeclarations = manifest.files.reduce((total, file) => total + file.declarations.length, 0);
    if (state.activeGenerations.size !== manifest.files.length || state.counts.activeFiles !== manifest.files.length ||
      state.counts.activeSymbols !== expectedDeclarations) failures.add('catalog_counts_mismatch');
    const dlq = await reader.metadataStore.getDeadLetterEntries();
    if (dlq.length !== 0) failures.add('dlq_not_empty', dlq.length);
    let vectorComplete = false;
    try {
      let rowsSinceBoundary = 0;
      for await (const row of reader.vectorStore.iterateAuditRows({ pageSize: 512, signal })) {
        signal.throwIfAborted();
        rowsSinceBoundary += 1;
        incrementRuntimeDiagnosticCounter({ stageId: 'S10_manifest_audit', counterId: 'audit.rows_seen', delta: 1, unit: 'rows', semantics: 'visited', sampleReason: 'threshold' });
        switch (row.view) {
          case 'legacy': counts.legacyRows += 1; break;
          case 'structured': counts.structuredRows += 1; break;
        }
        if (membership.accept(row)) {
          incrementRuntimeDiagnosticCounter({ stageId: 'S10_manifest_audit', counterId: 'audit.rows_verified', delta: 1, unit: 'rows', semantics: 'verified', sampleReason: 'threshold' });
        }
        if (rowsSinceBoundary === 512) {
          rowsSinceBoundary = 0;
          await runRuntimeDiagnosticStage('S10_manifest_audit', () => undefined);
        }
      }
      vectorComplete = true;
    } catch (error) {
      if (signal.aborted) throw error;
      failures.add('vector_read_error');
    }
    Object.assign(counts, membership.fileCounts);
    membership.finish(vectorComplete);
    const legacy = await reader.vectorStore.getStats();
    counts.legacyGetStats = legacy.totalChunks;
    const expectedLegacy = manifest.files.reduce((total, file) => total + file.legacyRows.length, 0);
    const expectedStructured = manifest.files.reduce((total, file) => total + file.structuredRows.length, 0);
    if (legacy.totalChunks !== expectedLegacy || legacy.totalFiles !== manifest.files.length ||
      legacy.totalChunks !== counts.legacyRows || legacy.totalFiles !== counts.legacyFiles ||
      stats?.totalChunks !== expectedLegacy || stats.totalFiles !== manifest.files.length) failures.add('legacy_stats_mismatch');
    if (counts.structuredRows !== expectedStructured || counts.structuredFiles !== manifest.files.length) failures.add('catalog_counts_mismatch');
    await auditCatalog(reader, manifest, { signal, counts, failures });
  } catch {
    if (signal.aborted) failures.add('audit_aborted');
    else failures.add('metadata_read_error');
  } finally {
    membership.finish(false);
    if (reader.stateRevision() !== revision) failures.add('concurrent_mutation');
  }
  const result = { counts, durationMs: performance.now() - started };
  const validationFailureCount = failures.records().reduce((total, failure) => total + failure.count, 0);
  incrementRuntimeDiagnosticCounter({ stageId: 'S10_manifest_audit', counterId: 'audit.validation_failures', delta: validationFailureCount, unit: 'failures', semantics: 'failed', sampleReason: 'threshold' });
  return auditResultSchema.parse(failures.invalid ? { status: 'invalid', ...result, failures: failures.records() }
    : { status: 'valid', ...result });
}

import { describe, expect, it, vi } from 'vitest';

import { createStructuredCoordinatorFixture, createStructuredStage } from '../../../../shared/structured-test-helpers.js';
import { createRuntimeDiagnosticContext } from '../../../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { withRuntimeDiagnosticContext } from '../../../../../src/observability/diagnostic-stage-trace.js';
import { createDiagnosticTestContext } from './diagnostic-test-helpers.js';

function generationInput(stage: ReturnType<typeof createStructuredStage>) {
  return {
    source: stage.source,
    generationId: stage.generationId,
    contentHash: stage.contentHash,
    fileCompleteness: 'complete' as const,
    declarations: [stage.symbol],
    imports: [],
  };
}

function runFullRebuild(
  fixture: Awaited<ReturnType<typeof createStructuredCoordinatorFixture>>,
  stage: ReturnType<typeof createStructuredStage>,
) {
  return fixture.coordinator.runFullRebuild({ files: [generationInput(stage)], merkleSnapshot: [] });
}

describe('structured storage diagnostic stages', () => {
  it('records generation and activation counters without paths', async () => {
    const fixture = await createStructuredCoordinatorFixture();
    const stage = createStructuredStage('private/structured.ts', 'export function sample() { return 1; }', 'sample');
    const context = createDiagnosticTestContext();

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), async () => {
      await fixture.coordinator.stageFile(generationInput(stage));
      await fixture.coordinator.activateFile({ filePath: stage.source.filePath, generationId: stage.generationId });
    });

    const trace = context.recorder.snapshot().events;
    const counters = trace.filter((event) => event.event === 'progress');
    const stageIds = trace.filter((event) => event.event === 'span_started').map((event) => event.stageId);
    expect(stageIds).toContain('S08_storage_write');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.sqlite_generation_stage_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.sqlite_generation_stage_succeeded', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.sqlite_declaration_rows_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.sqlite_declaration_rows_committed', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.sqlite_import_rows_attempted', value: 0 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.sqlite_import_rows_committed', value: 0 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.structured_vector_rows_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.structured_vector_rows_write_succeeded', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.structured_vector_rows_activated', value: 1 }));
    expect(JSON.stringify(trace)).not.toContain('private/structured.ts');
  });

  it('records full-rebuild generation and activation counters without paths', async () => {
    const fixture = await createStructuredCoordinatorFixture();
    const stage = createStructuredStage('private/full-rebuild.ts', 'export function rebuilt() { return 2; }', 'rebuilt');
    const context = createDiagnosticTestContext();

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      runFullRebuild(fixture, stage));

    const trace = context.recorder.snapshot().events;
    const counters = trace.filter((event) => event.event === 'progress');
    const finished = trace.filter((event) => event.event === 'span_finished');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.sqlite_generation_stage_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.sqlite_generation_stage_succeeded', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.structured_vector_rows_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.structured_vector_rows_write_succeeded', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.structured_vector_rows_activated', value: 1 }));
    expect(finished.some((event) => event.stageId === 'S08_storage_write' && event.stateIntegrity === 'verified')).toBe(true);
    expect(JSON.stringify(trace)).not.toContain('private/full-rebuild.ts');
  });

  it('preserves backup cleanup failure in a terminal span when full rebuild resolves', async () => {
    const fixture = await createStructuredCoordinatorFixture();
    const stage = createStructuredStage('private/cleanup.ts', 'export function cleanup() { return 5; }', 'cleanup');
    vi.spyOn(fixture.metadataStore, 'finalizeFullRebuild').mockRejectedValueOnce(new Error('injected cleanup failure'));
    const context = createDiagnosticTestContext();

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      runFullRebuild(fixture, stage));

    const finished = context.recorder.snapshot().events.filter((event) => event.event === 'span_finished');
    expect(finished.some((event) => event.stateIntegrity === 'backup_cleanup_failed')).toBe(true);
    expect((await fixture.metadataStore.getStructuredIndexState()).rebuildState).toBe('merkle-activated');
  });

  it('marks rollback uncertainty when full-rebuild rollback fails', async () => {
    const fixture = await createStructuredCoordinatorFixture();
    const stage = createStructuredStage('private/rollback.ts', 'export function rollback() { return 6; }', 'rollback');
    vi.spyOn(fixture.metadataStore, 'activateFullRebuild').mockRejectedValueOnce(new Error('injected activation failure'));
    vi.spyOn(fixture.metadataStore, 'rollbackFullRebuild').mockRejectedValueOnce(new Error('injected rollback failure'));
    const context = createDiagnosticTestContext();

    await expect(withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      runFullRebuild(fixture, stage))).rejects.toThrow('injected activation failure');

    const finished = context.recorder.snapshot().events.filter((event) => event.event === 'span_finished');
    expect(finished.some((event) => event.stateIntegrity === 'rollback_incomplete')).toBe(true);
  });

  it('marks a rejected vector write as unknown even when pending metadata is cleared', async () => {
    const fixture = await createStructuredCoordinatorFixture();
    const stage = createStructuredStage('private/partial-write.ts', 'export function partial() { return 7; }', 'partial');
    vi.spyOn(fixture.vectorStore, 'stageGenerationChunks').mockRejectedValueOnce(new Error('injected partial vector write'));
    const context = createDiagnosticTestContext();

    await expect(withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      fixture.coordinator.stageFile(generationInput(stage)))).rejects.toThrow('injected partial vector write');

    const finished = context.recorder.snapshot().events.filter((event) => event.event === 'span_finished');
    expect(finished.some((event) => event.stateIntegrity === 'unknown')).toBe(true);
  });

  it('marks pending-generation cleanup failure as rollback incomplete', async () => {
    const fixture = await createStructuredCoordinatorFixture();
    const stage = createStructuredStage('private/clear-pending.ts', 'export function clearPending() { return 8; }', 'clearPending');
    vi.spyOn(fixture.vectorStore, 'stageGenerationChunks').mockRejectedValueOnce(new Error('injected vector failure'));
    vi.spyOn(fixture.metadataStore, 'clearPendingGeneration').mockRejectedValueOnce(new Error('injected pending cleanup failure'));
    const context = createDiagnosticTestContext();

    await expect(withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      fixture.coordinator.stageFile(generationInput(stage)))).rejects.toThrow('injected pending cleanup failure');

    const finished = context.recorder.snapshot().events.filter((event) => event.event === 'span_finished');
    expect(finished.some((event) => event.stateIntegrity === 'rollback_incomplete')).toBe(true);
  });

  it('marks shadow-table abort failure as rollback incomplete', async () => {
    const fixture = await createStructuredCoordinatorFixture();
    const stage = createStructuredStage('private/abort-shadow.ts', 'export function abortShadow() { return 9; }', 'abortShadow');
    vi.spyOn(fixture.metadataStore, 'activateFullRebuild').mockRejectedValueOnce(new Error('injected activation failure'));
    vi.spyOn(fixture.vectorStore, 'abortStructuredShadowTable').mockRejectedValueOnce(new Error('injected shadow abort failure'));
    const context = createDiagnosticTestContext();

    await expect(withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      runFullRebuild(fixture, stage))).rejects.toThrow('injected activation failure');

    const finished = context.recorder.snapshot().events.filter((event) => event.event === 'span_finished');
    expect(finished.some((event) => event.stateIntegrity === 'rollback_incomplete')).toBe(true);
  });
});

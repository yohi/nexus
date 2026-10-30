import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  runRuntimeDiagnosticStage,
  createChildRuntimeDiagnosticContext,
  currentRuntimeDiagnosticContext,
  withRuntimeDiagnosticContext,
  withoutRuntimeDiagnosticContext,
  type RuntimeDiagnosticContext,
} from '../../../../../src/observability/diagnostic-stage-trace.js';
import { DirectoryScanner } from '../../../../../src/server/runtime/directory-scan.js';
import { MetricsHttpServer } from '../../../../../src/observability/metrics-server.js';
import { createBenchmarkRuntimeFactory } from '../../../../benchmarks/performance/runtime.js';
import { createTraceRecorder } from '../../../../benchmarks/performance/diagnostics/trace-recorder.js';
import { createRuntimeDiagnosticContext } from '../../../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { runWorkerStage } from '../../../../benchmarks/performance/diagnostics/worker-stage-context.js';

function workerContext() {
  return {
    recorder: createTraceRecorder({
      runId: '00000000-0000-4000-8000-000000000001', jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64),
      sourceFingerprint: 'b'.repeat(64), pid: 1234, processStartTicks: '4567', ppid: 1200,
      processRole: 'vitest_worker', clockDomain: 'process_local_monotonic',
    }, { nowNs: () => process.hrtime.bigint() }),
    operationId: 'op_0000000000000001', attemptId: 'attempt_1',
  };
}

const operationId = 'op_0000000000000001';
const attemptId = 'attempt_1';

function context(events: string[]): RuntimeDiagnosticContext {
  return {
    operationId,
    attemptId,
    runStage: async (input, work) => {
      events.push(`start:${input.stageId}`);
      try {
        return await work();
      } finally {
        events.push(`end:${input.stageId}`);
      }
    },
    progress: (input) => { events.push(`progress:${input.counterId}`); },
    markFailure: () => { events.push('failure'); },
    runDetached: (work) => work(),
  };
}

describe('runtime diagnostic stage scope', () => {
  it('records S03 assembly, S04 initialization, and S05 explicit reindex without changing runtime exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-runtime-diagnostics-'));
    const storageRoot = join(dirname(root), `${basename(root)}.nexus-perf-state`);
    const startServer = vi.spyOn(MetricsHttpServer.prototype, 'start').mockImplementation(() => Promise.resolve());
    const stopServer = vi.spyOn(MetricsHttpServer.prototype, 'stop').mockImplementation(() => Promise.resolve());
    const getPort = vi.spyOn(MetricsHttpServer.prototype, 'getPort').mockReturnValue(undefined);
    const worker = workerContext();
    const runtimeContext = createRuntimeDiagnosticContext(worker);
    let assembly: Awaited<ReturnType<ReturnType<typeof createBenchmarkRuntimeFactory>>> | undefined;
    try {
      assembly = await createBenchmarkRuntimeFactory(root, undefined, runtimeContext)(new AbortController().signal);
      await assembly.diagnostics.metadataStore.initialize();
      await assembly.diagnostics.metadataStore.setIndexStats({
        id: 'primary', totalFiles: 0, totalChunks: 0, lastIndexedAt: '2026-01-01T00:00:00.000Z',
        lastFullScanAt: null, overflowCount: 0, lastError: null,
      });
      await assembly.runtime.initialize();
      await withRuntimeDiagnosticContext(runtimeContext, async () => await assembly?.runtime.reindex(true));
      const events = worker.recorder.snapshot().events;
      const spans = events.filter((event) => event.event === 'span_started');
      expect(spans.map((event) => event.stageId)).toContain('S03_runtime_assembly');
      expect(spans.map((event) => event.stageId)).toContain('S04_runtime_initialization');
      expect(spans.map((event) => event.stageId)).toContain('S05_directory_scan');
      expect(spans.find((event) => event.stageId === 'S03_runtime_assembly')?.operationId)
        .toBe(spans.find((event) => event.stageId === 'S04_runtime_initialization')?.operationId);
      expect(spans.find((event) => event.stageId === 'S05_directory_scan')?.operationId)
        .not.toBe(spans.find((event) => event.stageId === 'S04_runtime_initialization')?.operationId);
    } finally {
      await assembly?.runtime.close();
      await rm(storageRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      startServer.mockRestore();
      stopServer.mockRestore();
      getPort.mockRestore();
    }
  });

  it('records exact path-free directory scan counts and returned events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-runtime-scan-'));
    try {
      await mkdir(join(root, 'child'));
      await writeFile(join(root, 'root.ts'), 'root');
      await writeFile(join(root, 'ignored.ts'), 'ignored');
      await writeFile(join(root, 'child', 'nested.ts'), 'nested');
      const defaultWorker = workerContext();
      const defaultEvents = await DirectoryScanner.scan(root, root, ['ignored.ts']);
      expect(defaultWorker.recorder.snapshot().events.filter((event) => event.event !== 'trace_status')).toEqual([]);
      const worker = workerContext();
      const runtimeContext = createRuntimeDiagnosticContext(worker);
      const events = await withRuntimeDiagnosticContext(runtimeContext, async () => {
        expect(currentRuntimeDiagnosticContext()).toBe(runtimeContext);
        return await DirectoryScanner.scan(root, root, ['ignored.ts']);
      });
      const trace = worker.recorder.snapshot().events;
      expect(events.map((event) => event.filePath).sort()).toEqual(['child/nested.ts', 'root.ts']);
      expect(events.map((event) => [event.type, event.filePath])).toEqual(defaultEvents.map((event) => [event.type, event.filePath]));
      expect(trace.filter((event) => event.event === 'span_started').map((event) => event.stageId)).toEqual(['S05_directory_scan']);
      const progress = trace.filter((event) => event.event === 'progress');
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'scan.entries_seen', value: 4 }));
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'scan.entries_ignored', value: 1 }));
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'scan.entries_eligible', value: 3 }));
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'scan.files_expected', value: events.length }));
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'scan.files_emitted', value: events.length }));
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'scan.directories_visited', value: 2 }));
      expect(JSON.stringify(trace)).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records nested async stages only inside the bound scope', async () => {
    const events: string[] = [];
    const result = await withRuntimeDiagnosticContext(context(events), async () => {
      const value = await runRuntimeDiagnosticStage('S03_runtime_assembly', async () => {
        await Promise.resolve();
        return runRuntimeDiagnosticStage('S04_runtime_initialization', () => 42);
      });
      await withoutRuntimeDiagnosticContext(() => runRuntimeDiagnosticStage('S04_runtime_initialization', () => {
        events.push('detached-work');
      }));
      return value;
    });
    await runRuntimeDiagnosticStage('S04_runtime_initialization', () => { events.push('outside-work'); });

    expect(result).toBe(42);
    expect(events).toEqual([
      'start:S03_runtime_assembly', 'start:S04_runtime_initialization', 'end:S04_runtime_initialization',
      'end:S03_runtime_assembly', 'detached-work', 'outside-work',
    ]);
  });

  it('assigns distinct child operation identities for repeated reindex work', async () => {
    const events: string[] = [];
    const parent = context(events);
    const identities = await withRuntimeDiagnosticContext(parent, async () => {
      const first = createChildRuntimeDiagnosticContext(parent, 'startup_reindex');
      const second = createChildRuntimeDiagnosticContext(parent, 'manual_reindex');
      await withRuntimeDiagnosticContext(first, async () => await runRuntimeDiagnosticStage('S05_directory_scan', () => undefined));
      await withRuntimeDiagnosticContext(second, async () => await runRuntimeDiagnosticStage('S05_directory_scan', () => undefined));
      return [first.operationId, second.operationId];
    });
    expect(identities[0]).toMatch(/^op_[a-f0-9]{24}$/);
    expect(identities[1]).toMatch(/^op_[a-f0-9]{24}$/);
    expect(identities[0]).not.toBe(identities[1]);
  });

  it('detaches both runtime and recorder async contexts for long-lived loops', async () => {
    const worker = workerContext();
    const runtimeContext = createRuntimeDiagnosticContext(worker);
    await withRuntimeDiagnosticContext(runtimeContext, async () => await runWorkerStage(worker,
      { stageId: 'S03_runtime_assembly', operationId, attemptId }, async () => {
        await withoutRuntimeDiagnosticContext(async () => await runRuntimeDiagnosticStage('S05_directory_scan', () => 42));
      }));
    expect(worker.recorder.snapshot().events.filter((event) => event.event === 'span_started').map((event) => event.stageId))
      .toEqual(['S03_runtime_assembly']);
  });
});

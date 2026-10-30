import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createTraceRecorder } from '../../../../benchmarks/performance/diagnostics/trace-recorder.js';
import type { StageInput } from '../../../../benchmarks/performance/diagnostics/contracts.js';
import { hasWorkerObserverFailure, runWorkerStage } from '../../../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { generateFixture } from '../../../../benchmarks/performance/fixtures.js';
import { preflightWorkload } from '../../../../benchmarks/performance/worker-preflight.js';
import { createRecipe } from '../../../../benchmarks/performance/fixture-recipe.js';
import * as fixtureRecipe from '../../../../benchmarks/performance/fixture-recipe.js';
import { profiles } from '../../../../benchmarks/performance/profiles.js';
import { diagnosticRequestMatchesWorker, workerDiagnosticRequestSchema, workerRequestSchema } from '../../../../benchmarks/performance/worker-contracts.js';
import { verifyOwnedDiagnosticDirectory } from '../../../../benchmarks/performance/diagnostics/owned-diagnostic-directory.js';
import { createWorkerDiagnosticContext } from '../../../../benchmarks/performance/diagnostics/create-worker-context.js';
import { runScenarioWorker } from '../../../../benchmarks/performance/worker-scenario.js';
import * as workerScenario from '../../../../benchmarks/performance/worker-scenario.js';
import * as runtimeFactory from '../../../../benchmarks/performance/runtime.js';
import { executeDiagnosticPerformanceWorker } from '../../../../benchmarks/performance/diagnostics/diagnostic-worker.js';
import { diagnosticTraceEventSchema } from '../../../../benchmarks/performance/diagnostics/contracts.js';
import * as traceWriter from '../../../../benchmarks/performance/diagnostics/trace-writer.js';
import { WorkerBudget } from '../../../../benchmarks/performance/worker-budget.js';
import { validateVectorDistribution } from '../../../../benchmarks/performance/synthetic-provider.js';

function recorder() {
  return createTraceRecorder({
    runId: '00000000-0000-4000-8000-000000000001', jobId: 'cold_initial_index',
    recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), pid: 1234,
    processStartTicks: '4567', ppid: 1200, processRole: 'vitest_worker', clockDomain: 'process_local_monotonic',
  }, { nowNs: () => process.hrtime.bigint() });
}

const operationId = 'op_0000000000000001';
const attemptId = 'attempt_1';

describe('worker diagnostic stages', () => {
  it('preserves a scenario error and flushes diagnostics when budget close fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-close-failure-'));
    const previousOptions = process.env.NODE_OPTIONS;
    const scenarioError = new Error('original scenario failure');
    const scenario = vi.spyOn(workerScenario, 'runScenarioWorker').mockRejectedValueOnce(scenarioError);
    let writes = 0;
    let closes = 0;
    let writtenContent = '';
    const writer = vi.spyOn(traceWriter, 'createTraceFileWriter').mockReturnValue({
      write: (content) => { writes += 1; writtenContent += content; return Promise.resolve(); },
      close: () => { closes += 1; return Promise.resolve(); },
    });
    try {
      const runId = '00000000-0000-4000-8000-000000000001';
      const directory = join(root, 'trace');
      const requestFile = join(root, 'request.json');
      const diagnosticFile = join(root, 'diagnostic.json');
      await mkdir(directory, { mode: 0o700 });
      await writeFile(requestFile, JSON.stringify({
        schemaVersion: 1, mode: 'scenario', runId, ownerRoot: root,
        resultFile: join(root, 'result.json'), phaseFile: join(root, 'phase.json'),
        deadlineEpochMs: Date.now() + 60_000, memoryLimitMb: 4096, timeoutMs: 60_000,
        options: { profile: 'smoke', outputMode: 'file', revision: { commit: null, dirty: null },
          timeoutMs: 60_000, auditPageSize: 10, cacheSeedBatchSize: 512, memoryLimitMb: 4096, sampleMode: 'smoke' },
        job: { id: 'cold_initial_index', kind: 'cold_initial_index', repeat: 0 },
      }), { mode: 0o600 });
      await writeFile(diagnosticFile, JSON.stringify({
        schemaVersion: 1, diagnosticOnly: true, runId, jobId: 'cold_initial_index',
        recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), runDirectory: directory,
        operationId, attemptId,
      }), { mode: 0o600 });
      process.env.NODE_OPTIONS = '--max-old-space-size=4096';
      await expect(executeDiagnosticPerformanceWorker(requestFile, diagnosticFile, {
        createBudget: () => ({
          signal: new AbortController().signal,
          refresh: () => undefined,
          setPhase: () => undefined,
          close: () => { throw new Error('injected close failure'); },
        }),
      })).rejects.toBe(scenarioError);
      expect(writes).toBe(1);
      expect(closes).toBe(1);
      expect(writtenContent).toContain('cleanup_failure');
      expect(writtenContent).toContain('"event":"resource_sample"');
      expect(writtenContent).toContain('S12_resource_cleanup');
    } finally {
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
      scenario.mockRestore();
      writer.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing file during initial fixture generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-fixture-existing-'));
    try {
      const file = join(root, fixtureRecipe.fixturePath(0));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'existing evidence');
      await expect(generateFixture(root, 'smoke')).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe('existing evidence');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts locally valid vectors separately from later global collision failure', () => {
    const vector = [1, ...Array.from({ length: 127 }, () => 0)];
    let validated = 0;
    expect(() => validateVectorDistribution([vector, vector], () => { validated += 1; })).toThrow();
    expect(validated).toBe(2);
  });

  it('retains an incomplete owned phase file and removes listeners if initial phase writing fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-phase-init-failure-'));
    const phaseFile = join(root, 'phase.json');
    const listenerCount = (): number => process.listenerCount('SIGTERM');
    const listenersBefore = listenerCount();
    const failure = new Error('injected phase failure');
    const spy = vi.spyOn(nodeFs, 'ftruncateSync').mockImplementationOnce(() => { throw failure; });
    syncBuiltinESMExports();
    try {
      expect(() => new WorkerBudget({ memoryLimitMb: 4096, deadlineEpochMs: Date.now() + 60_000, phaseFile }, { exclusivePhase: true })).toThrow(failure);
      expect(await readdir(root)).toEqual(['phase.json']);
      expect(listenerCount()).toBe(listenersBefore);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes later phase updates to the owned descriptor rather than a replacement path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-phase-replace-'));
    const phaseFile = join(root, 'phase.json');
    const ownedFile = join(root, 'owned-phase.json');
    let budget: WorkerBudget | undefined;
    try {
      budget = new WorkerBudget({ memoryLimitMb: 4096, deadlineEpochMs: Date.now() + 60_000, phaseFile }, { exclusivePhase: true });
      await rename(phaseFile, ownedFile);
      await writeFile(phaseFile, 'replacement evidence', { mode: 0o600 });
      budget.setPhase('indexing');
      expect(await readFile(phaseFile, 'utf8')).toBe('replacement evidence');
      expect(await readFile(ownedFile, 'utf8')).toContain('"phase":"indexing"');
    } finally {
      budget?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an existing phase file when exclusive diagnostic ownership is requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-phase-exclusive-'));
    const phaseFile = join(root, 'phase.json');
    let budget: WorkerBudget | undefined;
    try {
      await writeFile(phaseFile, 'existing evidence', { mode: 0o600 });
      expect(() => {
        budget = new WorkerBudget({ memoryLimitMb: 4096, deadlineEpochMs: Date.now() + 60_000, phaseFile }, { exclusivePhase: true });
      }).toThrow();
      expect(await readFile(phaseFile, 'utf8')).toBe('existing evidence');
    } finally {
      budget?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an existing phase file without overwriting it or launching a scenario', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-phase-'));
    const spy = vi.spyOn(workerScenario, 'runScenarioWorker');
    try {
      const runId = '00000000-0000-4000-8000-000000000001';
      const directory = join(root, 'trace');
      const requestFile = join(root, 'request.json');
      const diagnosticFile = join(root, 'diagnostic.json');
      const phaseFile = join(root, 'phase.json');
      await mkdir(directory, { mode: 0o700 });
      await writeFile(phaseFile, 'existing evidence', { mode: 0o600 });
      await writeFile(requestFile, JSON.stringify({
        schemaVersion: 1, mode: 'scenario', runId, ownerRoot: root,
        resultFile: join(root, 'result.json'), phaseFile,
        deadlineEpochMs: Date.now() + 60_000, memoryLimitMb: 4096, timeoutMs: 60_000,
        options: { profile: 'smoke', outputMode: 'file', revision: { commit: null, dirty: null },
          timeoutMs: 60_000, auditPageSize: 10, cacheSeedBatchSize: 512, memoryLimitMb: 4096, sampleMode: 'smoke' },
        job: { id: 'cold_initial_index', kind: 'cold_initial_index', repeat: 0 },
      }), { mode: 0o600 });
      await writeFile(diagnosticFile, JSON.stringify({
        schemaVersion: 1, diagnosticOnly: true, runId, jobId: 'cold_initial_index',
        recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), runDirectory: directory,
        operationId, attemptId,
      }), { mode: 0o600 });
      await expect(executeDiagnosticPerformanceWorker(requestFile, diagnosticFile)).rejects.toThrow('diagnostic_phase_path_exists');
      expect(await readFile(phaseFile, 'utf8')).toBe('existing evidence');
      expect(spy).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects oversized private control input before running a scenario', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-control-limit-'));
    const spy = vi.spyOn(workerScenario, 'runScenarioWorker');
    try {
      const requestFile = join(root, 'request.json');
      const diagnosticFile = join(root, 'diagnostic.json');
      await writeFile(requestFile, JSON.stringify({ padding: 'x'.repeat(65_537) }), { mode: 0o600 });
      await writeFile(diagnosticFile, '{}', { mode: 0o600 });
      await expect(executeDiagnosticPerformanceWorker(requestFile, diagnosticFile)).rejects.toThrow('diagnostic_control_file_too_large');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['write', 'close'] as const)('returns incomplete evidence if diagnostic writer %s fails', async (failureStage) => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-flush-'));
    const previousOptions = process.env.NODE_OPTIONS;
    const scenario = vi.spyOn(workerScenario, 'runScenarioWorker').mockResolvedValueOnce({ records: [], fixtureDigest: null, workload: null });
    const writer = vi.spyOn(traceWriter, 'createTraceFileWriter').mockReturnValue({
      write: () => failureStage === 'write' ? Promise.reject(new Error('private writer detail')) : Promise.resolve(),
      close: () => failureStage === 'close' ? Promise.reject(new Error('private writer detail')) : Promise.resolve(),
    });
    try {
      const runId = '00000000-0000-4000-8000-000000000001';
      const directory = join(root, 'trace');
      const requestFile = join(root, 'request.json');
      const diagnosticFile = join(root, 'diagnostic.json');
      await mkdir(directory, { mode: 0o700 });
      await writeFile(requestFile, JSON.stringify({
        schemaVersion: 1, mode: 'scenario', runId, ownerRoot: root,
        resultFile: join(root, 'result.json'), phaseFile: join(root, 'phase.json'),
        deadlineEpochMs: Date.now() + 60_000, memoryLimitMb: 4096, timeoutMs: 60_000,
        options: { profile: 'smoke', outputMode: 'file', revision: { commit: null, dirty: null },
          timeoutMs: 60_000, auditPageSize: 10, cacheSeedBatchSize: 512, memoryLimitMb: 4096, sampleMode: 'smoke' },
        job: { id: 'cold_initial_index', kind: 'cold_initial_index', repeat: 0 },
      }), { mode: 0o600 });
      await writeFile(diagnosticFile, JSON.stringify({
        schemaVersion: 1, diagnosticOnly: true, runId, jobId: 'cold_initial_index',
        recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), runDirectory: directory,
        operationId, attemptId,
      }), { mode: 0o600 });
      process.env.NODE_OPTIONS = '--max-old-space-size=4096';
      const result = await executeDiagnosticPerformanceWorker(requestFile, diagnosticFile);
      expect(result.scenario.records).toEqual([]);
      expect(result.traceIncomplete).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private writer detail');
    } finally {
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
      scenario.mockRestore();
      writer.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes an explicitly requested diagnostic scaffold with bootstrap trace and a mocked scenario', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-worker-'));
    const previousOptions = process.env.NODE_OPTIONS;
    const spy = vi.spyOn(workerScenario, 'runScenarioWorker').mockResolvedValueOnce({ records: [], fixtureDigest: null, workload: null });
    try {
      const runId = '00000000-0000-4000-8000-000000000001';
      const directory = join(root, 'trace');
      const requestFile = join(root, 'request.json');
      const diagnosticFile = join(root, 'diagnostic.json');
      await mkdir(directory, { mode: 0o700 });
      await writeFile(requestFile, JSON.stringify({
        schemaVersion: 1, mode: 'scenario', runId, ownerRoot: root,
        resultFile: join(root, 'result.json'), phaseFile: join(root, 'phase.json'),
        deadlineEpochMs: Date.now() + 60_000, memoryLimitMb: 4096, timeoutMs: 60_000,
        options: { profile: 'smoke', outputMode: 'file', revision: { commit: null, dirty: null },
          timeoutMs: 60_000, auditPageSize: 10, cacheSeedBatchSize: 512, memoryLimitMb: 4096, sampleMode: 'smoke' },
        job: { id: 'cold_initial_index', kind: 'cold_initial_index', repeat: 0 },
      }), { mode: 0o600 });
      await writeFile(diagnosticFile, JSON.stringify({
        schemaVersion: 1, diagnosticOnly: true, runId, jobId: 'cold_initial_index',
        recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), runDirectory: directory,
        operationId, attemptId,
      }), { mode: 0o600 });
      process.env.NODE_OPTIONS = '--max-old-space-size=4096';
      const result = await executeDiagnosticPerformanceWorker(requestFile, diagnosticFile);
      expect(result.diagnosticAdmissible).toBe(false);
      expect(spy).toHaveBeenCalledOnce();
      const traceName = (await readdir(directory)).find((entry) => entry.startsWith('trace-'));
      if (traceName === undefined) throw new Error('Expected diagnostic trace');
      const events = (await readFile(join(directory, traceName), 'utf8')).trim().split('\n')
        .map((line): unknown => JSON.parse(line)).map((value) => diagnosticTraceEventSchema.parse(value));
      expect(events).toContainEqual(expect.objectContaining({ event: 'span_started', stageId: 'S00_worker_bootstrap' }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'span_finished', stageId: 'S00_worker_bootstrap', status: 'completed' }));
      expect(events.at(-1)).toMatchObject({ event: 'trace_status', finalizationState: 'provisional', diagnosticAdmissible: false });
    } finally {
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes an opt-in context into fixture and preflight before runtime construction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-worker-scenario-context-'));
    const spy = vi.spyOn(runtimeFactory, 'createBenchmarkRuntimeFactory').mockImplementation(() => { throw new Error('stop before runtime'); });
    try {
      const runId = '00000000-0000-4000-8000-000000000001';
      const parsed = workerRequestSchema.parse({
        schemaVersion: 1, mode: 'scenario', runId, ownerRoot: root,
        resultFile: join(root, 'result.json'), phaseFile: join(root, 'phase.json'),
        deadlineEpochMs: Date.now() + 60_000, memoryLimitMb: 100, timeoutMs: 100,
        options: { profile: 'smoke', outputMode: 'file', revision: { commit: null, dirty: null },
          timeoutMs: 100, auditPageSize: 10, cacheSeedBatchSize: 512, memoryLimitMb: 100, sampleMode: 'smoke' },
        job: { id: 'cold_initial_index', kind: 'cold_initial_index', repeat: 0 },
      });
      if (parsed.mode !== 'scenario') throw new Error('Expected scenario request');
      const trace = recorder();
      const budget = { signal: new AbortController().signal, refresh: () => undefined, setPhase: () => undefined, close: () => undefined };
      await runScenarioWorker(parsed, budget, { recorder: trace, operationId, attemptId });
      const starts = trace.snapshot().events.filter((event) => event.event === 'span_started').map((event) => event.stageId);
      expect(starts).toEqual(['S01_fixture_generation', 'S02_workload_preflight']);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates a diagnostic context only for a verified owned request without creating a trace file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-worker-context-'));
    try {
      const traceDirectory = join(root, 'trace');
      await mkdir(traceDirectory, { mode: 0o700 });
      const runId = '00000000-0000-4000-8000-000000000001';
      const request = workerRequestSchema.parse({
        schemaVersion: 1, mode: 'scenario', runId, ownerRoot: root,
        resultFile: join(root, 'result.json'), phaseFile: join(root, 'phase.json'),
        deadlineEpochMs: 1, memoryLimitMb: 100, timeoutMs: 100,
        options: { profile: 'smoke', outputMode: 'file', revision: { commit: null, dirty: null },
          timeoutMs: 100, auditPageSize: 10, cacheSeedBatchSize: 512, memoryLimitMb: 100, sampleMode: 'smoke' },
        job: { id: 'cold_initial_index', kind: 'cold_initial_index', repeat: 0 },
      });
      if (request.mode !== 'scenario') throw new Error('Expected scenario request');
      const diagnostic = workerDiagnosticRequestSchema.parse({
        schemaVersion: 1, diagnosticOnly: true, runId, jobId: 'cold_initial_index',
        recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), runDirectory: traceDirectory,
        operationId, attemptId,
      });
      const result = await createWorkerDiagnosticContext(request, diagnostic, { bootstrapStartNs: 1000n });
      expect(result.status).toBe('ready');
      expect(await readdir(traceDirectory)).toEqual([]);
      const mismatch = await createWorkerDiagnosticContext(request, { ...diagnostic, runId: '00000000-0000-4000-8000-000000000002' });
      expect(mismatch).toMatchObject({ status: 'invalid', reason: 'request_mismatch' });
      expect(await readdir(traceDirectory)).toEqual([]);
      if (result.status !== 'ready') throw new Error('Expected diagnostic context');
      const value = await runWorkerStage(result.context, { stageId: 'S00_worker_bootstrap', operationId, attemptId }, () => 42);
      expect(value).toBe(42);
      expect(result.context.recorder.snapshot().events[0]).toMatchObject({ event: 'span_started', monotonicNs: '1000' });
      await result.context.recorder.flush(result.writer);
      await result.writer.close();
      expect((await readdir(traceDirectory)).filter((entry) => entry.startsWith('trace-'))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked or non-private diagnostic directories before worker instrumentation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-owned-diag-'));
    try {
      const owned = join(root, 'owned');
      const privateDirectory = join(owned, 'trace');
      const publicDirectory = join(owned, 'public');
      await mkdir(owned, { mode: 0o700 });
      await mkdir(privateDirectory, { mode: 0o700 });
      await mkdir(publicDirectory, { mode: 0o755 });
      await symlink(privateDirectory, join(owned, 'alias'));
      expect(await verifyOwnedDiagnosticDirectory(owned, privateDirectory)).toMatchObject({ status: 'valid' });
      expect(await verifyOwnedDiagnosticDirectory(owned, publicDirectory)).toMatchObject({ status: 'invalid' });
      expect(await verifyOwnedDiagnosticDirectory(owned, join(owned, 'alias'))).toMatchObject({ status: 'invalid' });
      expect(await verifyOwnedDiagnosticDirectory(owned, root)).toMatchObject({ status: 'invalid' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains an independent failure flag when the recorder failure marker also throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-worker-observer-marker-'));
    try {
      const trace = recorder();
      const context = { recorder: trace, operationId, attemptId };
      vi.spyOn(trace, 'progress').mockImplementation(() => { throw new Error('progress failed'); });
      vi.spyOn(trace, 'markObserverFailure').mockImplementation(() => { throw new Error('marker failed'); });
      const manifest = await generateFixture(root, 'smoke', context);
      expect(manifest.files).toHaveLength(20);
      expect(hasWorkerObserverFailure(context)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records preflight input counts accumulated before recipe construction fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-worker-preflight-failure-'));
    try {
      const manifest = await generateFixture(root, 'smoke');
      const first = manifest.files[0];
      if (first === undefined) throw new Error('Expected fixture file');
      const original = fixtureRecipe.createRecipe;
      const failure = new Error('preflight failure');
      const spy = vi.spyOn(fixtureRecipe, 'createRecipe').mockImplementationOnce(original).mockImplementationOnce(() => { throw failure; });
      try {
        const trace = recorder();
        await expect(preflightWorkload(manifest, { recorder: trace, operationId, attemptId })).rejects.toBe(failure);
        const samples = trace.snapshot().events.filter((event) => event.event === 'progress' && event.counterId === 'preflight.raw_text_inputs');
        expect(samples.at(-1)).toMatchObject({
          value: 128 + first.legacyRows.length + first.structuredRows.length, sampleReason: 'stage_end',
        });
      } finally {
        spy.mockRestore();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts only an explicitly enabled private diagnostic request matching the worker run', () => {
    const runId = '00000000-0000-4000-8000-000000000001';
    const request = {
      schemaVersion: 1, mode: 'scenario', runId, ownerRoot: '/diagnostic-test',
      resultFile: '/diagnostic-test/result.json', phaseFile: '/diagnostic-test/phase.json',
      deadlineEpochMs: 1, memoryLimitMb: 100, timeoutMs: 100,
      options: { profile: 'smoke', outputMode: 'file', revision: { commit: null, dirty: null },
        timeoutMs: 100, auditPageSize: 10, cacheSeedBatchSize: 512, memoryLimitMb: 100, sampleMode: 'smoke' },
      job: { id: 'cold_initial_index', kind: 'cold_initial_index', repeat: 0 },
      diagnostic: { schemaVersion: 1, diagnosticOnly: true, runId, jobId: 'cold_initial_index',
        recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), runDirectory: '/diagnostic-test/trace',
        operationId, attemptId },
    };
    expect(workerRequestSchema.safeParse(request).success).toBe(false);
    expect(workerDiagnosticRequestSchema.safeParse(request.diagnostic).success).toBe(true);
    expect(workerDiagnosticRequestSchema.safeParse({ ...request.diagnostic, diagnosticOnly: false }).success).toBe(false);
    const standard: unknown = Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'diagnostic'));
    const parsed = workerRequestSchema.parse(standard);
    if (parsed.mode !== 'scenario') throw new Error('Expected scenario request');
    const diagnostic = workerDiagnosticRequestSchema.parse(request.diagnostic);
    expect(diagnosticRequestMatchesWorker(parsed, diagnostic)).toBe(true);
    expect(diagnosticRequestMatchesWorker(parsed, { ...diagnostic, runId: '00000000-0000-4000-8000-000000000002' })).toBe(false);
    expect(diagnosticRequestMatchesWorker({ ...parsed, job: { ...parsed.job, kind: 'warm' } }, diagnostic)).toBe(false);
    expect(diagnosticRequestMatchesWorker(parsed, { ...diagnostic, runDirectory: '/outside-owned-root' })).toBe(false);
  });

  it('does not repeat completed work if the stage observer throws afterwards', async () => {
    const trace = recorder();
    vi.spyOn(trace, 'withStage').mockImplementation(async <T>(_input: StageInput, work: () => T | Promise<T>): Promise<T> => {
      await work();
      throw new Error('observer failed after work');
    });
    let calls = 0;
    const result = await runWorkerStage({ recorder: trace, operationId, attemptId },
      { stageId: 'S01_fixture_generation', operationId, attemptId }, () => { calls += 1; return 42; });
    expect(result).toBe(42);
    expect(calls).toBe(1);
    expect(trace.snapshot().traceIncomplete).toBe(true);
  });

  it('runs fixture work once if the stage observer fails before invoking it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-worker-stage-observer-'));
    try {
      const trace = recorder();
      vi.spyOn(trace, 'withStage').mockRejectedValueOnce(new Error('stage observer failed'));
      const manifest = await generateFixture(root, 'smoke', { recorder: trace, operationId, attemptId });
      expect(manifest.files).toHaveLength(20);
      expect(trace.snapshot().traceIncomplete).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps fixture work successful when the progress observer throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-worker-observer-'));
    try {
      const trace = recorder();
      vi.spyOn(trace, 'progress').mockImplementation(() => { throw new Error('observer private detail'); });
      const manifest = await generateFixture(root, 'smoke', { recorder: trace, operationId, attemptId });
      expect(manifest.files).toHaveLength(20);
      expect(trace.snapshot().traceIncomplete).toBe(true);
      expect(JSON.stringify(trace.snapshot())).not.toContain('observer private detail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records a completed file write even if describing that file fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-worker-failure-'));
    const failure = new Error('private detail');
    const spy = vi.spyOn(fixtureRecipe, 'describeRecipe').mockRejectedValueOnce(failure);
    try {
      const trace = recorder();
      await expect(generateFixture(root, 'smoke', { recorder: trace, operationId, attemptId })).rejects.toBe(failure);
      const events = trace.snapshot().events;
      expect(events).toContainEqual(expect.objectContaining({ event: 'progress', counterId: 'fixture.files_written_succeeded', value: 1 }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'span_finished', stageId: 'S01_fixture_generation', status: 'failed' }));
      expect(JSON.stringify(events)).not.toContain('private detail');
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('flushes final fixture counts on failure even when interim samples were coalesced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-worker-partial-'));
    const original = fixtureRecipe.describeRecipe;
    const failure = new Error('partial failure');
    const spy = vi.spyOn(fixtureRecipe, 'describeRecipe')
      .mockImplementationOnce(original).mockRejectedValueOnce(failure);
    try {
      const trace = recorder();
      await expect(generateFixture(root, 'smoke', { recorder: trace, operationId, attemptId })).rejects.toBe(failure);
      const writes = trace.snapshot().events.filter((event) => event.event === 'progress'
        && event.counterId === 'fixture.files_written_succeeded');
      expect(writes.at(-1)).toMatchObject({ value: 2, sampleReason: 'stage_end' });
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records fixture counts and preflight input counts without fixture paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-worker-stages-'));
    try {
      const trace = recorder();
      const context = { recorder: trace, operationId, attemptId };
      const manifest = await generateFixture(root, 'smoke', context);
      await preflightWorkload(manifest, context);
      const events = trace.snapshot().events;
      const starts = events.filter((event) => event.event === 'span_started').map((event) => event.stageId);
      expect(starts).toEqual(['S01_fixture_generation', 'S02_workload_preflight']);
      const progress = events.filter((event) => event.event === 'progress');
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'fixture.files_written_succeeded', value: manifest.files.length }));
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'fixture.bytes_written', value: manifest.bytes }));
      const texts = Array.from({ length: 128 }, (_, index) => `preflight-${index}`);
      for (const file of manifest.files) {
        const source = Buffer.from(createRecipe(file.recipeIndex, profiles.smoke.files, manifest.declarationsPerFile, file.variant).text);
        for (const row of file.legacyRows) texts.push(source.subarray(row.startByte, row.endByte).toString('utf8').trim());
        for (const row of file.structuredRows) texts.push(source.subarray(row.startByte, row.endByte).toString('utf8'));
      }
      for (const query of manifest.queries) if (typeof query.args.query === 'string') texts.push(query.args.query);
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'preflight.raw_text_inputs', value: texts.length }));
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'preflight.unique_text_inputs', value: new Set(texts).size }));
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'preflight.vectors_checked', value: new Set(texts).size }));
      expect(progress).toContainEqual(expect.objectContaining({ counterId: 'preflight.vectors_locally_validated', value: new Set(texts).size }));
      expect(JSON.stringify(events)).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains existing fixture and preflight behavior without diagnostic options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-worker-default-'));
    try {
      const manifest = await generateFixture(root, 'smoke');
      expect(manifest.files).toHaveLength(20);
      expect(() => preflightWorkload(manifest)).not.toThrow();
      expect((await readdir(root, { recursive: true })).some((entry) => entry.endsWith('.jsonl'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

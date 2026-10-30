import type { RuntimeAssembly } from '../../../src/server/runtime/assembly-types.js';
import type { AuditResult, FixtureManifest, ScenarioRecord } from './contracts.js';
import { scenarioRecordSchema } from './contracts.js';
import { captureNodeResources, systemClock } from './clock.js';
import { captureReadiness } from './readiness.js';
import type { RuntimeFactory } from './runtime.js';
import { LifecycleError, lifecycleBase } from './lifecycle-context.js';
import type { LifecycleContext, OperationKind, StartupKind } from './lifecycle-context.js';
import type { CacheAccounting } from './cache-accounting.js';
import { prepareIncrementalOperation } from './incremental-operation.js';
import { auditRuntime } from './audit.js';
import { probeReadiness } from './readiness-probe.js';
import { settleReadiness } from './readiness-settlement.js';
import { ReadinessError } from './readiness-error.js';
import { cacheSeedResultSchema, expectedCacheKeys } from './cache-seed.js';
import { syntheticEmbeddingConfig } from './synthetic-provider.js';
import { measureIndexArtifacts } from './resources.js';
import { runRuntimeDiagnosticStage } from '../../../src/observability/diagnostic-stage-trace.js';

export type { LifecycleContext, OperationKind, StartupKind } from './lifecycle-context.js';
let operationSequence = 0;

function cacheWasExercised(kind: StartupKind | OperationKind, accounting: CacheAccounting): boolean {
  switch (kind) {
    case 'cold_initial_index': case 'sibling_first': case 'sibling_second':
      return accounting.outcomes.miss > 0 && accounting.providerCalls > 0;
    case 'l2_rebuild': return accounting.outcomes.l2_hit > 0 && accounting.outcomes.miss === 0 && accounting.providerCalls === 0;
    case 'warm_restart': return accounting.outcomes.miss === 0 && accounting.providerCalls === 0;
    case 'l1_replay': return accounting.outcomes.l1_hit > 0 && accounting.outcomes.miss === 0 && accounting.providerCalls === 0;
    case 'incremental': return accounting.outcomes.miss > 0 && accounting.providerCalls > 0;
  }
}

export async function runStartupScenario(kind: StartupKind, createRuntime: RuntimeFactory,
  manifest: FixtureManifest, context: Readonly<LifecycleContext>): Promise<ScenarioRecord> {
  const clock = context.clock ?? systemClock;
  const setupStart = clock.now();
  const base = { ...lifecycleBase(kind, context), fixtureDigest: manifest.digest };
  const seed = kind === 'l2_rebuild' ? cacheSeedResultSchema.safeParse(context.cacheSeed) : undefined;
  if (kind === 'l2_rebuild') {
    const keys = expectedCacheKeys(manifest, syntheticEmbeddingConfig);
    const digest = createHash('sha256').update(JSON.stringify(keys)).digest('hex');
    if (!seed?.success || seed.data.status !== 'valid' || seed.data.keySetDigest !== digest ||
      seed.data.expectedKeyCount !== keys.length || seed.data.verifiedKeyCount !== keys.length ||
      seed.data.maxRequestedBatchSize !== Math.min(512, keys.length)) {
      return scenarioRecordSchema.parse({ ...base, status: 'invalid', phase: 'setup',
        elapsedMs: context.setupMs + clock.now() - setupStart,
        failures: [{ code: 'cache_seed_unverified', count: 1, examples: [] }],
        ...(seed?.success ? { cacheSeed: seed.data } : {}) });
    }
  }
  const setupMs = context.setupMs + clock.now() - setupStart;
  const cpu = process.cpuUsage();
  const captured = await captureReadiness(createRuntime, context.collector, manifest, clock, context.signal);
  if (captured.status === 'invalid') return scenarioRecordSchema.parse({ ...base, ...captured.record,
    elapsedMs: setupMs + captured.record.elapsedMs,
    ...(seed?.success ? { cacheSeed: seed.data } : {}),
    ...(captured.record.candidateEndpoints === undefined ? {} : { candidateEndpoints: {
      ...captured.record.candidateEndpoints, setup_ms: setupMs } }) });
  try {
    if (manifest.profile !== context.run.profile) throw new LifecycleError('profile_mismatch');
    if (!cacheWasExercised(kind, captured.record.cacheAccounting)) throw new LifecycleError('cache_state_not_exercised');
    await runRuntimeDiagnosticStage('S12_resource_cleanup', () => captured.assembly.runtime.close());
    context.signal.throwIfAborted();
    const artifactBytes = await runRuntimeDiagnosticStage('S12_resource_cleanup', () =>
      measureIndexArtifacts(captured.assembly.diagnostics, context.signal));
    return scenarioRecordSchema.parse({ ...base, ...captured.record, sampleKind: 'lifecycle',
      artifactBytes,
      indexingMode: kind === 'warm_restart' ? 'startup_reconciliation' : 'full_rebuild',
      rawSamples: [captured.record.endpoints.runtime_ready_ms], resources: captureNodeResources(cpu, 'runtime_to_completion'),
      ...(seed?.success ? { cacheSeed: seed.data } : {}),
      endpoints: { ...captured.record.endpoints, setup_ms: setupMs,
        benchmark_completion_ms: clock.now() - captured.startedAt,
        ...(seed?.success ? { cache_seed_ms: seed.data.durationMs } : {}) } });
  } catch (error) {
    const code = context.signal.aborted ? 'readiness_aborted' : error instanceof LifecycleError ? error.code : 'cleanup_failed';
    const failures = [{ code, count: 1, examples: [] }];
    try { await runRuntimeDiagnosticStage('S12_resource_cleanup', () => captured.assembly.runtime.close()); }
    catch { failures.push({ code: 'cleanup_failed', count: 1, examples: [] }); }
    return scenarioRecordSchema.parse({ ...base, status: 'invalid', phase: 'worker', elapsedMs: setupMs + clock.now() - captured.startedAt,
      failures,
      ...(seed?.success ? { cacheSeed: seed.data } : {}),
      candidateEndpoints: { ...captured.record.endpoints, setup_ms: setupMs } });
  } finally {
    await runRuntimeDiagnosticStage('S12_resource_cleanup', () => context.collector.release(captured.requestId));
  }
}

export async function runExistingRuntimeScenario(kind: OperationKind, assembly: RuntimeAssembly,
  manifest: FixtureManifest, context: Readonly<LifecycleContext>): Promise<ScenarioRecord> {
  const clock = context.clock ?? systemClock;
  const preparationStart = clock.now();
  const base = { ...lifecycleBase(kind, context), fixtureDigest: manifest.digest };
  const requestId = `operation-${++operationSequence}`;
  let restore: (() => Promise<void>) | undefined;
  let currentManifest = manifest;
  let operationStart = preparationStart;
  let operationMs: number | undefined;
  let setupMs = context.setupMs;
  let audit: AuditResult | undefined;
  let phase: 'setup' | 'indexing' | 'audit' | 'probe' | 'worker' = 'setup';
  return context.collector.run(requestId, async () => {
    try {
      context.signal.throwIfAborted();
      let invoke = () => assembly.runtime.reindex(true);
      if (kind === 'incremental') {
        const prepared = await prepareIncrementalOperation(assembly, manifest, context.collector);
        currentManifest = prepared.manifest; restore = prepared.restore; invoke = prepared.invoke;
      }
      const cpu = process.cpuUsage();
      phase = 'indexing';
      operationStart = clock.now();
      setupMs += operationStart - preparationStart;
      await invoke();
      await settleReadiness(assembly, context.collector, requestId, context.signal);
      const operationEnd = clock.now();
      operationMs = operationEnd - operationStart;
      const revision = assembly.diagnostics.stateRevision();
      phase = 'audit';
      audit = await auditRuntime(assembly.diagnostics, currentManifest, context.signal);
      const auditEnd = clock.now();
      if (audit.status !== 'valid') throw new ReadinessError('audit_invalid');
      phase = 'probe';
      const probe = await probeReadiness(assembly, currentManifest, context.collector, context.signal);
      const probeEnd = clock.now();
      if (revision !== assembly.diagnostics.stateRevision() || context.collector.hasRuntimeFailure) throw new ReadinessError('concurrent_mutation');
      const accounting = context.collector.cacheAccounting(requestId);
      if (!cacheWasExercised(kind, accounting)) throw new LifecycleError('cache_state_not_exercised');
      phase = 'worker';
      await runRuntimeDiagnosticStage('S12_resource_cleanup', async () => { await restore?.(); });
      restore = undefined;
      context.signal.throwIfAborted();
      return scenarioRecordSchema.parse({ ...base, status: 'valid', sampleKind: 'lifecycle', rawSamples: [operationMs],
        fixtureDigest: currentManifest.digest,
        indexingMode: kind === 'l1_replay' ? 'full_rebuild' : 'incremental_queue',
        audit, validation: probe.validation, readinessProbe: probe.info, cacheAccounting: accounting,
        resources: captureNodeResources(cpu, 'operation_to_completion'),
        endpoints: { indexing_operation_ms: operationMs, audit_validation_ms: auditEnd - operationEnd,
          retrieval_probe_ms: probeEnd - auditEnd, benchmark_completion_ms: clock.now() - operationStart, setup_ms: setupMs } });
    } catch (error) {
      const code = context.signal.aborted ? 'readiness_aborted' : error instanceof ReadinessError || error instanceof LifecycleError
        ? error.code : 'operation_failed';
      const failures = [{ code, count: 1, examples: [] }, ...(audit?.status === 'invalid' ? audit.failures : [])];
      try {
        await runRuntimeDiagnosticStage('S12_resource_cleanup', async () => { await restore?.(); });
      } catch {
        failures.push({ code: 'cleanup_failed', count: 1, examples: [] });
      }
      return scenarioRecordSchema.parse({ ...base, status: 'invalid', phase,
        fixtureDigest: currentManifest.digest,
        elapsedMs: context.setupMs + clock.now() - preparationStart, failures,
        ...(operationMs === undefined ? {} : { candidateEndpoints: { indexing_operation_ms: operationMs, setup_ms: setupMs } }) });
    } finally {
      await runRuntimeDiagnosticStage('S12_resource_cleanup', () => context.collector.release(requestId));
    }
  });
}
import { createHash } from 'node:crypto';

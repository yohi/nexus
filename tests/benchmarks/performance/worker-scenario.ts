import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeAssembly } from '../../../src/server/runtime/assembly-types.js';
import type { FixtureManifest, ScenarioRecord } from './contracts.js';
import { scenarioRecordSchema } from './contracts.js';
import { generateFixture } from './fixtures.js';
import { preflightWorkload } from './worker-preflight.js';
import { summarizeFixture } from './workload.js';
import type { WorkloadSummary } from './workload.js';
import type { ScenarioRequest } from './worker-contracts.js';
import { WorkerBudgetError } from './worker-budget.js';
import type { WorkerExecutionBudget } from './worker-budget.js';
import type { WorkerStageContext } from './diagnostics/worker-stage-context.js';
import type { RuntimeDiagnosticContext } from '../../../src/observability/diagnostic-stage-trace.js';
import { OutcomeCollector } from './outcomes.js';
import { createBenchmarkRuntimeFactory } from './runtime.js';
import { captureReadiness } from './readiness.js';
import { systemClock } from './clock.js';
import { runExistingRuntimeScenario, runStartupScenario } from './lifecycle.js';
import { runSiblingScenarios } from './sibling-scenarios.js';
import { createCacheSeedTarget, seedCompatibleCache } from './cache-seed.js';
import type { CacheSeedTarget } from './cache-seed.js';
import { syntheticEmbeddingConfig } from './synthetic-provider.js';
import { invalidJobRecords } from './worker-records.js';
import { artifactRoots, retrievalWorkerRecords } from './worker-retrieval.js';
import { measureIndexArtifacts } from './resources.js';
import { runRuntimeDiagnosticStage } from '../../../src/observability/diagnostic-stage-trace.js';
import { cleanupWorkerArtifacts } from './worker-cleanup.js';

type WorkerScenarioState = {
  workspace: string | undefined;
  assembly: RuntimeAssembly | undefined;
  target: Readonly<CacheSeedTarget> | undefined;
  workload: WorkloadSummary | null;
  manifest: FixtureManifest | undefined;
  records: readonly ScenarioRecord[];
  roots: ReturnType<typeof artifactRoots> | undefined;
};

type WorkerScenarioInput = Readonly<{
  request: ScenarioRequest;
  budget: WorkerExecutionBudget;
  diagnostic?: WorkerStageContext;
  runtimeDiagnosticContext?: RuntimeDiagnosticContext;
  collector: OutcomeCollector;
  started: number;
  state: WorkerScenarioState;
}>;

export async function runScenarioWorker(request: ScenarioRequest, budget: WorkerExecutionBudget, diagnostic?: WorkerStageContext,
  runtimeDiagnosticContext?: RuntimeDiagnosticContext) {
  const started = performance.now();
  const collector = new OutcomeCollector(budget.signal);
  const state: WorkerScenarioState = {
    workspace: undefined, assembly: undefined, target: undefined, workload: null,
    manifest: undefined, records: [], roots: undefined,
  };
  try {
    budget.signal.throwIfAborted();
    await executeScenarioWork({ request, budget, diagnostic, runtimeDiagnosticContext, collector, started, state });
    await closeAssembly(state);
    budget.signal.throwIfAborted();
    await measureScenarioArtifacts({ budget, state });
  } catch (error) {
    const reason: unknown = budget.signal.aborted ? budget.signal.reason : error;
    const code = reason instanceof WorkerBudgetError ? reason.code : 'worker_runtime_failed';
    state.records = await invalidJobRecords(request, code, performance.now() - started);
  } finally {
    try {
      const assembly = state.assembly;
      const target = state.target;
      const workspace = state.workspace;
      await cleanupWorkerArtifacts({
        ...(assembly === undefined ? {} : { closeRuntime: () => assembly.runtime.close() }),
        ...(target === undefined ? {} : { disposeTarget: () => target.dispose() }),
        ...(workspace === undefined ? {} : { removeWorkspace: () => rm(workspace, { recursive: true, force: true }) }),
      });
    } catch {
      state.records = await invalidJobRecords(request, 'worker_cleanup_failed', performance.now() - started, 'worker');
    }
    await runRuntimeDiagnosticStage('S12_resource_cleanup', () => collector.releaseAll());
  }
  return { records: state.records, fixtureDigest: state.workload?.digest ?? null, workload: state.workload };
}

async function executeScenarioWork(input: WorkerScenarioInput): Promise<void> {
  if (input.request.job.kind === 'siblings') {
    await executeSiblingWork(input);
    return;
  }
  await executeStandaloneWork(input);
}

async function executeSiblingWork(input: WorkerScenarioInput): Promise<void> {
  const { request, budget, collector, started, state } = input;
  state.records = await runSiblingScenarios(request.options.profile,
    { run: request.options, collector, signal: budget.signal, setupMs: performance.now() - started },
    (fixture) => { state.manifest = fixture; preflightWorkload(fixture); state.workload = summarizeFixture(fixture); });
}

async function executeStandaloneWork(input: WorkerScenarioInput): Promise<void> {
  const { request, budget, collector, started, state } = input;
  state.workspace = await realpath(await mkdtemp(join(request.ownerRoot, 'fixture-')));
  const root = join(state.workspace, 'source');
  await mkdir(root);
  state.manifest = await generateFixture(root, request.options.profile, input.diagnostic);
  const manifest = state.manifest;
  if (input.diagnostic === undefined) preflightWorkload(manifest);
  else await preflightWorkload(manifest, input.diagnostic);
  budget.refresh();
  state.workload = summarizeFixture(manifest);
  const factory = createBenchmarkRuntimeFactory(root, collector, input.runtimeDiagnosticContext);
  if (request.job.kind === 'cold_initial_index') {
    budget.setPhase('construction');
    state.records = [await runStartupScenario('cold_initial_index', async (signal) => {
      const built = await factory(signal);
      state.roots = artifactRoots(built);
      return built;
    }, manifest, { run: request.options, collector, signal: budget.signal, setupMs: performance.now() - started })];
    return;
  }
  const ready = await captureReadiness(factory, collector, manifest, systemClock, budget.signal);
  if (ready.status !== 'valid') {
    state.records = await invalidJobRecords(request, 'preparation_readiness_failed', performance.now() - started, 'setup');
    return;
  }
  state.assembly = ready.assembly;
  state.roots = artifactRoots(ready.assembly);
  await executeReadyJob({ ...input, root, ready });
}

async function executeReadyJob(input: WorkerScenarioInput & Readonly<{ root: string; ready: Extract<Awaited<ReturnType<typeof captureReadiness>>, { status: 'valid' }> }>): Promise<void> {
  const manifest = input.state.manifest;
  if (manifest === undefined) throw new Error('worker_manifest_missing');
  switch (input.request.job.kind) {
    case 'l1_replay':
    case 'incremental':
      await runIncrementalJob(input, input.request.job.kind);
      return;
    case 'warm_restart':
      await runWarmRestartJob(input);
      return;
    case 'l2_rebuild':
      await runL2RebuildJob(input);
      return;
    case 'warm':
    case 'first_call':
      input.state.records = await retrievalWorkerRecords({
        request: input.request, budget: input.budget, collector: input.collector,
        root: input.root, manifest, ready: input.ready, started: input.started,
      });
      return;
    case 'cold_initial_index':
    case 'siblings':
      return;
  }
}

async function runIncrementalJob(input: WorkerScenarioInput & Readonly<{ ready: Extract<Awaited<ReturnType<typeof captureReadiness>>, { status: 'valid' }> }>,
  kind: 'l1_replay' | 'incremental'): Promise<void> {
  const { request, budget, collector, started, state, ready } = input;
  budget.setPhase('indexing');
  const manifest = state.manifest;
  if (manifest === undefined) throw new Error('worker_manifest_missing');
  state.records = [await runExistingRuntimeScenario(kind, ready.assembly,
    manifest, { run: request.options, collector, signal: budget.signal, setupMs: performance.now() - started })];
}

async function runWarmRestartJob(input: WorkerScenarioInput & Readonly<{ root: string; ready: Extract<Awaited<ReturnType<typeof captureReadiness>>, { status: 'valid' }> }>): Promise<void> {
  const { request, budget, collector, started, state, root, runtimeDiagnosticContext } = input;
  const assembly = state.assembly;
  const manifest = state.manifest;
  if (assembly === undefined || manifest === undefined) throw new Error('warm_restart_runtime_missing');
  await runRuntimeDiagnosticStage('S12_resource_cleanup', () => assembly.runtime.close());
  state.assembly = undefined;
  await runRuntimeDiagnosticStage('S12_resource_cleanup', () => collector.releaseAll());
  const observer = new OutcomeCollector(budget.signal);
  try {
    budget.setPhase('construction');
    state.records = [await runStartupScenario('warm_restart', createBenchmarkRuntimeFactory(root, observer, runtimeDiagnosticContext),
      manifest, { run: request.options, collector: observer, signal: budget.signal, setupMs: performance.now() - started })];
  } finally {
    observer.releaseAll();
  }
}

async function runL2RebuildJob(input: WorkerScenarioInput & Readonly<{ ready: Extract<Awaited<ReturnType<typeof captureReadiness>>, { status: 'valid' }> }>): Promise<void> {
  const { request, budget, started, state, runtimeDiagnosticContext } = input;
  const oldAssembly = state.assembly;
  if (oldAssembly === undefined) throw new Error('l2_rebuild_runtime_missing');
  const target = await createCacheSeedTarget();
  state.target = target;
  const targetManifest = await generateFixture(target.projectRoot, request.options.profile);
  const seeded = await seedCompatibleCache({ metadataStore: oldAssembly.diagnostics.metadataStore,
    databasePath: oldAssembly.diagnostics.metadataDbPath, embeddingConfig: syntheticEmbeddingConfig },
  target, targetManifest, budget.signal);
  await runRuntimeDiagnosticStage('S12_resource_cleanup', () => oldAssembly.runtime.close());
  state.assembly = undefined;
  if (seeded.status !== 'valid') {
    state.records = (await invalidJobRecords(request, seeded.code, performance.now() - started, 'setup'))
      .map((record) => scenarioRecordSchema.parse({ ...record, cacheSeed: seeded }));
    return;
  }
  await target.metadataStore.close();
  const observer = new OutcomeCollector(budget.signal);
  try {
    budget.setPhase('construction');
    const targetFactory = createBenchmarkRuntimeFactory(target.projectRoot, observer, runtimeDiagnosticContext);
    state.records = [await runStartupScenario('l2_rebuild', async (signal) => {
      const built = await targetFactory(signal);
      state.roots = artifactRoots(built);
      return built;
    }, targetManifest, { run: request.options, collector: observer, signal: budget.signal,
      setupMs: performance.now() - started, cacheSeed: seeded })];
  } finally {
    observer.releaseAll();
  }
}

async function closeAssembly(state: WorkerScenarioState): Promise<void> {
  if (state.assembly === undefined) return;
  const assembly = state.assembly;
  await runRuntimeDiagnosticStage('S12_resource_cleanup', () => assembly.runtime.close());
  state.assembly = undefined;
}

async function measureScenarioArtifacts(input: Readonly<{ budget: WorkerExecutionBudget; state: WorkerScenarioState }>): Promise<void> {
  const { budget, state } = input;
  const roots = state.roots;
  if (roots === undefined || !state.records.some((record) => record.status === 'valid')) return;
  const bytes = await runRuntimeDiagnosticStage('S12_resource_cleanup', () => measureIndexArtifacts(roots, budget.signal));
  state.records = state.records.map((record) => record.status === 'valid'
    ? scenarioRecordSchema.parse({ ...record, artifactBytes: bytes }) : record);
}

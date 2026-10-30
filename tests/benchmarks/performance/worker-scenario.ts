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

export async function runScenarioWorker(request: ScenarioRequest, budget: WorkerExecutionBudget, diagnostic?: WorkerStageContext,
  runtimeDiagnosticContext?: RuntimeDiagnosticContext) {
  const started = performance.now();
  const collector = new OutcomeCollector(budget.signal);
  let workspace: string | undefined;
  let assembly: RuntimeAssembly | undefined;
  let target: Readonly<CacheSeedTarget> | undefined;
  let workload: WorkloadSummary | null = null;
  let manifest: FixtureManifest | undefined;
  let records: readonly ScenarioRecord[] = [];
  let roots: ReturnType<typeof artifactRoots> | undefined;
  try {
    budget.signal.throwIfAborted();
    if (request.job.kind === 'siblings') {
      records = await runSiblingScenarios(request.options.profile,
        { run: request.options, collector, signal: budget.signal, setupMs: performance.now() - started },
        (fixture) => { manifest = fixture; preflightWorkload(fixture); workload = summarizeFixture(fixture); });
    } else {
      workspace = await realpath(await mkdtemp(join(request.ownerRoot, 'fixture-')));
      const root = join(workspace, 'source'); await mkdir(root);
      manifest = await generateFixture(root, request.options.profile, diagnostic);
      if (diagnostic === undefined) preflightWorkload(manifest);
      else await preflightWorkload(manifest, diagnostic);
      budget.refresh(); workload = summarizeFixture(manifest);
      const factory = createBenchmarkRuntimeFactory(root, collector, runtimeDiagnosticContext);
      if (request.job.kind === 'cold_initial_index') {
        budget.setPhase('construction');
        records = [await runStartupScenario('cold_initial_index', async (signal) => {
          const built = await factory(signal); roots = artifactRoots(built); return built;
        }, manifest, { run: request.options, collector, signal: budget.signal, setupMs: performance.now() - started })];
      } else {
        const ready = await captureReadiness(factory, collector, manifest, systemClock, budget.signal);
        if (ready.status !== 'valid') records = await invalidJobRecords(request, 'preparation_readiness_failed', performance.now() - started, 'setup');
        else {
          assembly = ready.assembly; roots = artifactRoots(assembly);
          switch (request.job.kind) {
            case 'l1_replay': case 'incremental':
              budget.setPhase('indexing');
              records = [await runExistingRuntimeScenario(request.job.kind, assembly, manifest,
                { run: request.options, collector, signal: budget.signal, setupMs: performance.now() - started })];
              break;
            case 'warm_restart': {
              const oldAssembly = assembly;
              await runRuntimeDiagnosticStage('S12_resource_cleanup', () => oldAssembly.runtime.close());
              assembly = undefined;
              await runRuntimeDiagnosticStage('S12_resource_cleanup', () => collector.releaseAll());
              const observer = new OutcomeCollector(budget.signal);
              try {
                budget.setPhase('construction');
                records = [await runStartupScenario('warm_restart', createBenchmarkRuntimeFactory(root, observer, runtimeDiagnosticContext), manifest,
                  { run: request.options, collector: observer, signal: budget.signal, setupMs: performance.now() - started })];
              } finally { observer.releaseAll(); }
              break;
            }
            case 'l2_rebuild': {
              const oldAssembly = assembly;
              target = await createCacheSeedTarget();
              const targetManifest = await generateFixture(target.projectRoot, request.options.profile);
              const seeded = await seedCompatibleCache({ metadataStore: oldAssembly.diagnostics.metadataStore,
                databasePath: oldAssembly.diagnostics.metadataDbPath, embeddingConfig: syntheticEmbeddingConfig }, target, targetManifest, budget.signal);
              await runRuntimeDiagnosticStage('S12_resource_cleanup', () => oldAssembly.runtime.close());
              assembly = undefined;
              if (seeded.status !== 'valid') records = (await invalidJobRecords(request, seeded.code, performance.now() - started, 'setup'))
                .map((record) => scenarioRecordSchema.parse({ ...record, cacheSeed: seeded }));
              else {
                await target.metadataStore.close();
                const observer = new OutcomeCollector(budget.signal);
                try {
                  budget.setPhase('construction');
                  const targetFactory = createBenchmarkRuntimeFactory(target.projectRoot, observer, runtimeDiagnosticContext);
                  records = [await runStartupScenario('l2_rebuild', async (signal) => {
                    const built = await targetFactory(signal); roots = artifactRoots(built); return built;
                  }, targetManifest, { run: request.options, collector: observer, signal: budget.signal,
                    setupMs: performance.now() - started, cacheSeed: seeded })];
                } finally { observer.releaseAll(); }
              }
              break;
            }
            case 'warm': case 'first_call':
              records = await retrievalWorkerRecords({ request, budget, collector, root, manifest, ready, started });
              break;
          }
        }
      }
    }
    if (assembly !== undefined) {
      const readyAssembly = assembly;
      await runRuntimeDiagnosticStage('S12_resource_cleanup', () => readyAssembly.runtime.close());
      assembly = undefined;
    }
    budget.signal.throwIfAborted();
    if (roots !== undefined && records.some((record) => record.status === 'valid')) {
      const measuredRoots = roots;
      const bytes = await runRuntimeDiagnosticStage('S12_resource_cleanup', () =>
        measureIndexArtifacts(measuredRoots, budget.signal));
      records = records.map((record) => record.status === 'valid' ? scenarioRecordSchema.parse({ ...record, artifactBytes: bytes }) : record);
    }
  } catch (error) {
    const reason: unknown = budget.signal.aborted ? budget.signal.reason : error;
    const code = reason instanceof WorkerBudgetError ? reason.code : 'worker_runtime_failed';
    records = await invalidJobRecords(request, code, performance.now() - started);
  } finally {
    try {
      const openAssembly = assembly;
      const ownedTarget = target;
      const ownedWorkspace = workspace;
      await cleanupWorkerArtifacts({
        ...(openAssembly === undefined ? {} : { closeRuntime: () => openAssembly.runtime.close() }),
        ...(ownedTarget === undefined ? {} : { disposeTarget: () => ownedTarget.dispose() }),
        ...(ownedWorkspace === undefined ? {} : { removeWorkspace: () => rm(ownedWorkspace, { recursive: true, force: true }) }),
      });
    } catch { records = await invalidJobRecords(request, 'worker_cleanup_failed', performance.now() - started, 'worker'); }
    await runRuntimeDiagnosticStage('S12_resource_cleanup', () => collector.releaseAll());
  }
  return { records, fixtureDigest: workload?.digest ?? null, workload };
}

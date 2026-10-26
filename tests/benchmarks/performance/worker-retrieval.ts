import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import type { FixtureManifest, ScenarioRecord } from './contracts.js';
import { scenarioRecordSchema } from './contracts.js';
import type { RuntimeAssembly } from '../../../src/server/runtime/assembly-types.js';
import type { ReadinessCapture } from './readiness.js';
import type { ScenarioRequest } from './worker-contracts.js';
import type { WorkerBudget } from './worker-budget.js';
import type { OutcomeCollector } from './outcomes.js';
import { createFixturePathNormalizer } from './logical-path.js';
import { runRetrievalCase } from './retrieval.js';
import { runFirstCallGroup } from './first-call.js';
import { createBenchmarkRuntimeFactory } from './runtime.js';
import { captureResources } from './resources.js';

export interface RetrievalWorkerContext {
  readonly request: ScenarioRequest;
  readonly budget: WorkerBudget;
  readonly collector: OutcomeCollector;
  readonly root: string;
  readonly manifest: FixtureManifest;
  readonly ready: Extract<ReadinessCapture, { status: 'valid' }>;
  readonly started: number;
}

export async function retrievalWorkerRecords(context: Readonly<RetrievalWorkerContext>): Promise<readonly ScenarioRecord[]> {
  const { request, budget, collector, root, manifest, ready, started } = context;
  const normalize = await createFixturePathNormalizer(root, manifest, budget.signal);
  const setupMs = performance.now() - started;
  const records: ScenarioRecord[] = [];
  const first = request.job.kind === 'first_call';
  const handlers = buildToolHandlers(ready.assembly.options, ready.assembly.runtime.initialize.bind(ready.assembly.runtime));
  if (first) await ready.assembly.runtime.close();
  budget.setPhase('retrieval');
  for (const query of manifest.queries) {
    budget.signal.throwIfAborted();
    const cpu = process.cpuUsage();
    const base = { id: `${first ? 'first' : 'warm'}-${query.id}`, revision: request.options.revision,
      boundary: 'handler-internal', cacheState: 'persisted', sampleMode: request.options.sampleMode,
      memoryLimitMb: request.options.memoryLimitMb, fixtureDigest: manifest.digest };
    const facts = first ? await runFirstCallGroup((observer) => createBenchmarkRuntimeFactory(root, observer), query,
      { run: request.options, manifest, signal: budget.signal }, normalize)
      : await runRetrievalCase(handlers, query, collector,
        { run: request.options, manifest, signal: budget.signal, mode: 'warm' }, normalize);
    if (facts.status !== 'valid') {
      records.push(scenarioRecordSchema.parse({ ...base, status: 'invalid', phase: 'retrieval',
        failures: facts.failures, candidateSamples: facts.candidateSamples, elapsedMs: facts.elapsedMs,
        queryMetadata: facts.queryMetadata, grepExecution: facts.grepExecution }));
    } else {
      records.push(scenarioRecordSchema.parse({ ...base, status: 'valid', sampleKind: first ? 'first_call' : 'warm',
        rawSamples: facts.rawSamples, audit: 'audit' in facts ? facts.audit : ready.record.audit,
        validation: facts.validation, resources: 'resources' in facts ? facts.resources : captureResources(cpu, 'handler_group'),
        endpoints: { setup_ms: setupMs }, readinessProbe: ready.record.readinessProbe,
        ...('readiness' in facts ? { readinessRuns: facts.readiness } : {}),
        warmupCalls: facts.warmupCalls, measuredCalls: facts.measuredCalls,
        queryMetadata: facts.queryMetadata, grepExecution: facts.grepExecution }));
    }
    budget.refresh();
  }
  return records;
}

export function artifactRoots(assembly: RuntimeAssembly) {
  return { metadataDbPath: assembly.diagnostics.metadataDbPath, vectorDbPath: assembly.diagnostics.vectorDbPath };
}

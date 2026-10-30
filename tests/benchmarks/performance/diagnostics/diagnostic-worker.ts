import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { workerDiagnosticRequestSchema, workerRequestSchema, type ScenarioRequest } from '../worker-contracts.js';
import { WorkerBudget, type WorkerExecutionBudget } from '../worker-budget.js';
import { runScenarioWorker } from '../worker-scenario.js';
import { createWorkerDiagnosticContext } from './create-worker-context.js';
import { hasWorkerObserverFailure, markWorkerCleanupFailure, markWorkerObserverFailure, runWorkerStage } from './worker-stage-context.js';
import { withRuntimeDiagnosticContext } from '../../../../src/observability/diagnostic-stage-trace.js';

type DiagnosticWorkerDependencies = Readonly<{
  createBudget: (request: ScenarioRequest) => WorkerExecutionBudget;
}>;

const defaultDependencies: DiagnosticWorkerDependencies = Object.freeze({
  createBudget: (request) => new WorkerBudget(request, { exclusivePhase: true }),
});

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

const MAX_CONTROL_BYTES = 64 * 1024;

async function readControlFile(file: string): Promise<Readonly<{ canonical: string; text: string }>> {
  if (process.platform !== 'linux' || !isAbsolute(file) || process.getuid === undefined) throw new Error('invalid_diagnostic_control_file');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [canonical, info] = await Promise.all([realpath(`/proc/self/fd/${handle.fd}`), handle.stat()]);
    if (canonical !== resolve(file) || !info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()) {
      throw new Error('invalid_diagnostic_control_file');
    }
    if (info.size > MAX_CONTROL_BYTES) throw new Error('diagnostic_control_file_too_large');
    const bytes = Buffer.alloc(MAX_CONTROL_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, null);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    if (count > MAX_CONTROL_BYTES) throw new Error('diagnostic_control_file_too_large');
    return { canonical, text: bytes.subarray(0, count).toString('utf8') };
  } finally {
    await handle.close();
  }
}

export async function executeDiagnosticPerformanceWorker(
  requestFile: string,
  diagnosticFile: string,
  dependencies: DiagnosticWorkerDependencies = defaultDependencies,
) {
  const bootstrapStartNs = process.hrtime.bigint();
  const requestControl = await readControlFile(requestFile);
  const diagnosticControl = await readControlFile(diagnosticFile);
  const request = workerRequestSchema.parse(JSON.parse(requestControl.text));
  const diagnostic = workerDiagnosticRequestSchema.parse(JSON.parse(diagnosticControl.text));
  if (request.mode !== 'scenario') throw new Error('invalid_diagnostic_worker_mode');
  const owner = await realpath(request.ownerRoot);
  if (owner !== resolve(request.ownerRoot)) throw new Error('invalid_diagnostic_owner');
  if (!inside(owner, requestControl.canonical) || !inside(owner, diagnosticControl.canonical)) {
    throw new Error('invalid_diagnostic_control_file');
  }
  const phaseParent = await realpath(dirname(request.phaseFile));
  if (phaseParent !== resolve(dirname(request.phaseFile)) || !inside(owner, resolve(request.phaseFile))) {
    throw new Error('invalid_diagnostic_phase_path');
  }
  try {
    await lstat(request.phaseFile);
    throw new Error('diagnostic_phase_path_exists');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }

  const initialized = await createWorkerDiagnosticContext(request, diagnostic, { bootstrapStartNs });
  if (initialized.status !== 'ready') throw new Error(`diagnostic_context_${initialized.reason}`);
  const { context, runtimeContext, writer, resourceSampler } = initialized;
  let budget: WorkerExecutionBudget | undefined;
  let scenario: Awaited<ReturnType<typeof runScenarioWorker>> | undefined;
  try {
    resourceSampler.start();
  } catch {
    markWorkerObserverFailure(context);
  }
  try {
    const activeBudget = await runWorkerStage(context, {
      stageId: 'S00_worker_bootstrap', operationId: context.operationId, attemptId: context.attemptId,
    }, () => {
      const created = dependencies.createBudget(request);
      if (created.signal.aborted) {
        const reason: unknown = created.signal.reason;
        created.close();
        throw reason;
      }
      return created;
    });
    budget = activeBudget;
    scenario = await withRuntimeDiagnosticContext(runtimeContext,
      async () => await runScenarioWorker(request, activeBudget, context, runtimeContext));
  } finally {
    try {
      await runWorkerStage(context, {
        stageId: 'S12_resource_cleanup', operationId: context.operationId, attemptId: context.attemptId,
      }, () => {
        try {
          resourceSampler.stop();
        } catch {
          markWorkerObserverFailure(context);
        }
        try {
          budget?.close();
        } catch {
          context.recorder.markStateIntegrity('unknown');
          markWorkerCleanupFailure(context);
        }
      });
    } catch {
      markWorkerCleanupFailure(context);
    }
    try {
      await context.recorder.flush(writer);
    } catch {
      markWorkerObserverFailure(context);
    }
    try {
      await writer.close();
    } catch {
      markWorkerObserverFailure(context);
    }
  }
  if (scenario === undefined) throw new Error('diagnostic_scenario_unavailable');
  return { scenario, observerFailure: hasWorkerObserverFailure(context),
    traceIncomplete: context.recorder.snapshot().traceIncomplete, diagnosticAdmissible: false as const };
}

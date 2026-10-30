import type { DiagnosticTraceRecorder } from './trace-recorder.js';
import type { ProgressInput, StageInput } from './contracts.js';
import { attemptIdSchema, diagnosticStageIdSchema, operationIdSchema, progressInputSchema } from './contracts.js';
import type { RuntimeDiagnosticContext } from '../../../../src/observability/diagnostic-stage-trace.js';
import type { WorkerResourceSampler } from './resource-sampler.js';

export type WorkerStageContext = Readonly<{
  recorder: DiagnosticTraceRecorder;
  operationId: string;
  attemptId: string;
  resourceSampler?: WorkerResourceSampler;
}>;

const failedContexts = new WeakSet<WorkerStageContext>();

export function hasWorkerObserverFailure(context: WorkerStageContext): boolean {
  return failedContexts.has(context);
}

export function createRuntimeDiagnosticContext(context: WorkerStageContext): RuntimeDiagnosticContext {
  return {
    operationId: context.operationId,
    attemptId: context.attemptId,
    runStage: (input, work) => {
      const stageId = diagnosticStageIdSchema.safeParse(input.stageId);
      const operationId = operationIdSchema.safeParse(input.operationId);
      const attemptId = attemptIdSchema.safeParse(input.attemptId);
      if (!stageId.success || !operationId.success || !attemptId.success) {
        markWorkerObserverFailure(context);
        return Promise.resolve().then(work);
      }
      return runWorkerStage(context, { stageId: stageId.data, operationId: operationId.data, attemptId: attemptId.data }, work);
    },
    progress: (input) => {
      const progress = progressInputSchema.safeParse(input);
      if (!progress.success) {
        markWorkerObserverFailure(context);
        return;
      }
      recordWorkerProgress(context, progress.data);
    },
    markFailure: () => markWorkerObserverFailure(context),
    markStateIntegrity: (stateIntegrity) => context.recorder.markStateIntegrity(stateIntegrity),
    runDetached: (work) => context.recorder.withoutCurrentSpan(work),
  };
}

export function markWorkerObserverFailure(context: WorkerStageContext): void {
  failedContexts.add(context);
  try {
    context.recorder.markObserverFailure();
  } catch {
    return;
  }
}

export function markWorkerCleanupFailure(context: WorkerStageContext): void {
  failedContexts.add(context);
  try {
    context.recorder.markCleanupFailure();
  } catch {
    return;
  }
}

export async function runWorkerStage<T>(context: WorkerStageContext, input: StageInput, work: () => T | Promise<T>): Promise<T> {
  let invoked: Promise<T> | undefined;
  const runOnce = (): Promise<T> => {
    invoked ??= Promise.resolve().then(async () => {
      context.resourceSampler?.sampleBoundary();
      try {
        return await work();
      } finally {
        context.resourceSampler?.sampleBoundary();
      }
    });
    return invoked;
  };
  try {
    await context.recorder.withStage(input, runOnce);
  } catch {
    if (invoked === undefined) {
      markWorkerObserverFailure(context);
      return await runOnce();
    }
    const result = await invoked;
    markWorkerObserverFailure(context);
    return result;
  }
  if (invoked === undefined) {
    markWorkerObserverFailure(context);
    return await runOnce();
  }
  return await invoked;
}

export function recordWorkerProgress(context: WorkerStageContext | undefined, input: ProgressInput): void {
  if (context === undefined) return;
  try {
    context.recorder.progress(input);
  } catch {
    markWorkerObserverFailure(context);
  }
}

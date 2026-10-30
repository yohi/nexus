import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export type RuntimeDiagnosticStageInput = Readonly<{
  stageId: string;
  operationId: string;
  attemptId: string;
}>;

export type RuntimeDiagnosticProgressInput = Readonly<{
  counterId: string;
  value: number;
  unit: string;
  semantics: 'failed' | 'pending' | 'visited' | 'attempted' | 'completed' | 'succeeded' | 'returned' | 'verified' | 'committed' | 'classified' | 'retained';
  sampleReason: 'threshold' | 'interval' | 'stage_end';
  expected?: number;
}>;

export type RuntimeDiagnosticStateIntegrity = 'unknown' | 'verified' | 'rollback_incomplete' | 'backup_cleanup_failed';

export type RuntimeDiagnosticCounterInput = Readonly<{
  stageId: string;
  counterId: string;
  delta: number;
  unit: string;
  semantics: RuntimeDiagnosticProgressInput['semantics'];
  expected?: number;
  sampleReason: 'threshold' | 'interval';
}>;

export type RuntimeDiagnosticContext = Readonly<{
  operationId: string;
  attemptId: string;
  runStage: <T>(input: RuntimeDiagnosticStageInput, work: () => T | Promise<T>) => Promise<T>;
  progress: (input: RuntimeDiagnosticProgressInput) => void;
  markFailure: () => void;
  markStateIntegrity?: (stateIntegrity: RuntimeDiagnosticStateIntegrity) => void;
  runDetached: <T>(work: () => T) => T;
}>;

const contextStorage = new AsyncLocalStorage<RuntimeDiagnosticContext | undefined>();
const childSequence = new WeakMap<RuntimeDiagnosticContext, number>();
const counterValues = new WeakMap<RuntimeDiagnosticContext, Map<string, RuntimeDiagnosticProgressInput>>();

export function createChildRuntimeDiagnosticContext(
  parent: RuntimeDiagnosticContext,
  label: 'startup_reindex' | 'manual_reindex',
): RuntimeDiagnosticContext {
  const sequence = (childSequence.get(parent) ?? 0) + 1;
  childSequence.set(parent, sequence);
  const digest = createHash('sha256').update(`${parent.operationId}\0${label}\0${sequence}`).digest('hex').slice(0, 24);
  return Object.freeze({ ...parent, operationId: `op_${digest}`, attemptId: `attempt_${sequence}` });
}
export function withRuntimeDiagnosticContext<T>(context: RuntimeDiagnosticContext, work: () => T): T {
  return contextStorage.run(context, work);
}

export function withoutRuntimeDiagnosticContext<T>(work: () => T): T {
  const context = contextStorage.getStore();
  return context === undefined
    ? work()
    : context.runDetached(() => contextStorage.run(undefined, work));
}

export function currentRuntimeDiagnosticContext(): RuntimeDiagnosticContext | undefined {
  return contextStorage.getStore();
}

export async function runRuntimeDiagnosticStage<T>(stageId: string, work: () => T | Promise<T>): Promise<T> {
  const context = currentRuntimeDiagnosticContext();
  if (context === undefined) return await work();
  return await context.runStage({ stageId, operationId: context.operationId, attemptId: context.attemptId }, async () => {
    try {
      return await work();
    } finally {
      flushRuntimeDiagnosticCounters(stageId);
    }
  });
}

export function recordRuntimeDiagnosticProgress(input: RuntimeDiagnosticProgressInput): void {
  const context = currentRuntimeDiagnosticContext();
  if (context === undefined) return;
  try {
    context.progress(input);
  } catch {
    try {
      context.markFailure();
    } catch {
      return;
    }
  }
}

export function markRuntimeDiagnosticStateIntegrity(stateIntegrity: RuntimeDiagnosticStateIntegrity): void {
  const context = currentRuntimeDiagnosticContext();
  if (context === undefined || context.markStateIntegrity === undefined) return;
  try {
    context.markStateIntegrity(stateIntegrity);
  } catch {
    try {
      context.markFailure();
    } catch {
      return;
    }
  }
}

export function incrementRuntimeDiagnosticCounter(input: RuntimeDiagnosticCounterInput): void {
  const context = currentRuntimeDiagnosticContext();
  if (context === undefined || !Number.isSafeInteger(input.delta) || input.delta < 0) return;
  const values = counterValues.get(context) ?? new Map<string, RuntimeDiagnosticProgressInput>();
  const key = `${input.stageId}\0${input.counterId}`;
  const previous = values.get(key);
  const value = (previous?.value ?? 0) + input.delta;
  if (!Number.isSafeInteger(value)) {
    context.markFailure();
    return;
  }
  const progress: RuntimeDiagnosticProgressInput = {
    counterId: input.counterId, value, unit: input.unit, semantics: input.semantics,
    sampleReason: input.sampleReason, ...(input.expected === undefined ? {} : { expected: input.expected }),
  };
  values.set(key, progress);
  counterValues.set(context, values);
  recordRuntimeDiagnosticProgress(progress);
}

function flushRuntimeDiagnosticCounters(stageId: string): void {
  const context = currentRuntimeDiagnosticContext();
  if (context === undefined) return;
  const values = counterValues.get(context);
  if (values === undefined) return;
  for (const [key, progress] of values) {
    if (!key.startsWith(`${stageId}\0`)) continue;
    recordRuntimeDiagnosticProgress({ ...progress, sampleReason: 'stage_end' });
  }
}

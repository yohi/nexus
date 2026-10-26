import type { GrepMatch, ReindexResult } from '../types/index.js';
import { emitRuntimeEvent, getObservationContext, markRuntimeMutation, safelyNotify,
  withObservationContext } from './runtime-observer.js';
import type { EventIdentity, GrepEvidenceRef, RuntimeEventPayload, RuntimeObserver, RuntimeWorkKind } from './runtime-observer.js';

let workSequence = 0;
const reindexOwners = new WeakMap<object, string>();

export function startRuntimeWork(observer: RuntimeObserver, work: RuntimeWorkKind) {
  const parent = getObservationContext();
  const workId = `work-${++workSequence}`;
  const identity: EventIdentity = { workId, parentWorkId: parent?.workId,
    context: parent, time: performance.now() };
  const emit = (payload: RuntimeEventPayload) => safelyNotify(observer, { ...identity, time: performance.now(), ...payload });
  emit({ kind: 'work_started', work });
  return {
    workId, emit,
    finish: (outcome: 'success' | 'failed' | 'aborted' | 'timeout' | 'incomplete' | 'already_running') =>
      emit({ kind: 'work_finished', work, outcome }),
    run: <T>(callback: () => T): T => parent === undefined ? callback()
      : withObservationContext({ ...parent, workId, parentWorkId: parent.workId }, callback),
  };
}

export async function observeRuntimeWork<T>(observer: RuntimeObserver | undefined, kind: RuntimeWorkKind,
  work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (observer === undefined) return work();
  const scope = startRuntimeWork(observer, kind);
  const mutates = kind === 'reindex' || kind === 'process_events' || kind === 'drain' || kind === 'compaction';
  if (mutates) markRuntimeMutation(observer);
  return scope.run(async () => {
    try {
      const result = await work();
      scope.finish(signal?.aborted ? 'aborted' : 'success');
      return result;
    } catch (error) {
      scope.finish(signal?.aborted ? 'aborted' : 'failed');
      throw error;
    } finally {
      if (mutates) markRuntimeMutation(observer);
    }
  });
}

type RawReindexResult = ReindexResult | { status: 'already_running' } | { status: 'incomplete' };
export async function observeReindex(observer: RuntimeObserver | undefined, owner: object,
  work: () => Promise<RawReindexResult>): Promise<RawReindexResult> {
  if (observer === undefined) return work();
  const previousOwner = reindexOwners.get(owner);
  return observeRuntimeWork(observer, 'reindex', async () => {
    const workId = getObservationContext()?.workId;
    if (previousOwner === undefined && workId !== undefined) reindexOwners.set(owner, workId);
    try {
      const result = await work();
      if ('status' in result) {
        switch (result.status) {
          case 'already_running': emitRuntimeEvent(observer, { kind: 'reindex_finished',
            outcome: { status: 'already_running', ownerWorkId: previousOwner } }); break;
          case 'incomplete': emitRuntimeEvent(observer, { kind: 'reindex_finished', outcome: { status: 'incomplete' } }); break;
        }
      } else {
        emitRuntimeEvent(observer, { kind: 'reindex_finished', outcome: { status: 'fulfilled',
          result: Object.freeze({ ...result, reconciliation: Object.freeze({ ...result.reconciliation }) }) } });
      }
      return result;
    } catch (error) {
      emitRuntimeEvent(observer, { kind: 'reindex_finished', outcome: { status: 'rejected', code: 'reindex_rejected' } });
      throw error;
    } finally {
      if (workId !== undefined && reindexOwners.get(owner) === workId) reindexOwners.delete(owner);
    }
  });
}

export function captureObservedGrep(observer: RuntimeObserver | undefined, matches: readonly GrepMatch[],
  stage: 'direct' | 'hybrid'): GrepEvidenceRef | undefined {
  if (observer === undefined) return undefined;
  const context = getObservationContext();
  let evidence: GrepEvidenceRef | undefined;
  if (context !== undefined) {
    try { evidence = observer.captureGrepResults?.(context, matches); }
    catch { /* Failed diagnostic capture is represented as unavailable evidence. */ }
  }
  emitRuntimeEvent(observer, { kind: 'grep_results_captured', evidence, stage,
    lineMatchCount: matches.length, submatchCount: matches.reduce((total, match) => total + match.submatches.length, 0) });
  return evidence;
}

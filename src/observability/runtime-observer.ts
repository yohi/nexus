import { AsyncLocalStorage } from 'node:async_hooks';
import type { GrepMatch, ReindexResult } from '../types/index.js';
import type { EmbeddingCacheOutcome } from './types.js';

export type EmbeddingChunkOrigin = 'legacy' | 'structured';
export interface EmbeddingInputIdentity {
  readonly origin?: EmbeddingChunkOrigin;
  readonly keyDigest?: string;
}

export interface ObservationContext {
  readonly requestId: string;
  readonly phaseId: string;
}

export interface GrepEvidenceRef { readonly token: symbol; }
export type RuntimeWorkKind = 'reindex' | 'process_events' | 'drain' | 'semantic' | 'grep' | 'grep_spawn' | 'hybrid' |
  'semantic_branch' | 'grep_branch' | 'initialization' | 'compaction';
export type ReindexTerminalOutcome =
  | { readonly status: 'fulfilled'; readonly result: Readonly<ReindexResult> }
  | { readonly status: 'rejected'; readonly code: 'reindex_rejected' }
  | { readonly status: 'incomplete' }
  | { readonly status: 'already_running'; readonly ownerWorkId?: string };
export type GrepChildOutcome =
  | { readonly status: 'exited'; readonly exitCode: 0 | 1 }
  | { readonly status: 'failed_exit'; readonly exitCode: number }
  | { readonly status: 'signal_termination'; readonly signal: NodeJS.Signals }
  | { readonly status: 'aborted' }
  | { readonly status: 'timeout' }
  | { readonly status: 'spawn_failure' }
  | { readonly status: 'parser_failure' };
export type EventIdentity = {
  readonly time: number;
  readonly workId: string;
  readonly parentWorkId?: string;
  readonly context?: ObservationContext;
};
export type RuntimeEventPayload =
  | { readonly kind: 'work_started'; readonly work: RuntimeWorkKind }
  | { readonly kind: 'work_finished'; readonly work: RuntimeWorkKind;
      readonly outcome: 'success' | 'failed' | 'aborted' | 'timeout' | 'incomplete' | 'already_running';
      readonly ownerWorkId?: string }
  | { readonly kind: 'compaction_failed' }
  | { readonly kind: 'reindex_finished'; readonly outcome: ReindexTerminalOutcome }
  | { readonly kind: 'grep_child_finished'; readonly outcome: GrepChildOutcome }
  | { readonly kind: 'drain_state'; readonly pending: number; readonly queued: number;
      readonly postScanQueued: number; readonly dropped: number }
  | { readonly kind: 'queue_state'; readonly queued: number; readonly postScanQueued: number;
      readonly dropped: number; readonly postScanActive: boolean; readonly state: 'normal' | 'overflow' | 'full_scan' }
  | { readonly kind: 'grep_invalid_match' }
  | { readonly kind: 'grep_signal'; readonly reason: 'timeout' | 'aborted' }
  | { readonly kind: 'grep_results_captured'; readonly evidence?: GrepEvidenceRef;
      readonly lineMatchCount: number; readonly submatchCount: number; readonly stage: 'direct' | 'hybrid' }
  | { readonly kind: 'state_changed'; readonly revision: number }
  | { readonly kind: 'cache_lookup'; readonly outcome: EmbeddingCacheOutcome; readonly input: EmbeddingInputIdentity }
  | { readonly kind: 'embedding_batch_submitted'; readonly batchId: string; readonly entries: readonly EmbeddingInputIdentity[] }
  | { readonly kind: 'embedding_batch_finished'; readonly batchId: string; readonly outcome: 'fulfilled' | 'rejected' }
;
export type RuntimeEvent = EventIdentity & RuntimeEventPayload;
export interface RuntimeObserver {
  onEvent(event: RuntimeEvent): void;
  captureGrepResults?(context: ObservationContext, matches: readonly GrepMatch[]): GrepEvidenceRef;
}

export interface RuntimeObservationContext extends ObservationContext {
  readonly workId?: string;
  readonly parentWorkId?: string;
}
const observationContext = new AsyncLocalStorage<RuntimeObservationContext>();
const revisions = new WeakMap<RuntimeObserver, number>();
const queuedContexts = new WeakMap<object, RuntimeObservationContext>();

export function withObservationContext<T>(context: Readonly<RuntimeObservationContext>, work: () => T): T {
  return observationContext.run(context, work);
}
export const getObservationContext = (): RuntimeObservationContext | undefined => observationContext.getStore();

export function rememberQueuedObservation(event: object): void {
  const context = getObservationContext();
  if (context !== undefined) queuedContexts.set(event, context);
}

export function withQueuedObservation<T>(event: object, work: () => T): T {
  const context = queuedContexts.get(event);
  return context === undefined ? work() : withObservationContext(context, work);
}

export function safelyNotify(observer: RuntimeObserver | undefined, event: RuntimeEvent): void {
  try { observer?.onEvent(event); }
  catch { /* Diagnostic observers must never change production results or logs. */ }
}

export function emitRuntimeEvent(observer: RuntimeObserver | undefined, event: RuntimeEventPayload): void {
  if (observer === undefined) return;
  const context = getObservationContext();
  safelyNotify(observer, { ...event, time: performance.now(), workId: context?.workId ?? 'unscoped',
    parentWorkId: context?.parentWorkId, context });
}

export const runtimeStateRevision = (observer?: RuntimeObserver): number => observer === undefined ? 0 : revisions.get(observer) ?? 0;

export function markRuntimeMutation(observer?: RuntimeObserver): void {
  if (observer === undefined) return;
  const revision = runtimeStateRevision(observer) + 1;
  revisions.set(observer, revision);
  emitRuntimeEvent(observer, { kind: 'state_changed', revision });
}

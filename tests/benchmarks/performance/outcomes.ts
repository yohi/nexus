import { withObservationContext } from '../../../src/observability/runtime-observer.js';
import type { GrepEvidenceRef, ObservationContext, RuntimeEvent, RuntimeObserver, RuntimeWorkKind } from '../../../src/observability/runtime-observer.js';
import type { GrepMatch, ReindexResult } from '../../../src/types/index.js';
import { GrepEvidenceStore } from './grep-evidence.js';
import { cacheAccountingFailures, summarizeCacheEvents } from './cache-accounting.js';
import { assertNever } from './assert-never.js';
import type { GrepExecution } from './execution-contracts.js';

type WorkState = {
  readonly start: Extract<RuntimeEvent, { kind: 'work_started' }>;
  readonly requestId: string;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  terminal?: Extract<RuntimeEvent, { kind: 'work_finished' }>;
};
export type SealedOutcome = Readonly<{ status: 'valid' | 'invalid'; failures: readonly string[]; workCount: number;
  workKinds: readonly RuntimeWorkKind[];
  grepEvidence?: Readonly<{ direct?: GrepEvidenceRef; hybrid?: GrepEvidenceRef }>;
  grepExecution: readonly GrepExecution[];
}>;
const observationError = (error: unknown): Error => error instanceof Error ? error : new Error('observation_failed');
const statefulWork: ReadonlySet<RuntimeWorkKind> = new Set(['reindex', 'process_events', 'drain', 'compaction', 'initialization']);
class EvidenceUnavailableError extends Error {
  readonly code = 'request_aborted';
  constructor() { super('request_aborted'); this.name = 'EvidenceUnavailableError'; }
}

export class OutcomeCollector implements RuntimeObserver {
  private readonly events = new Map<string, RuntimeEvent[]>();
  private readonly failures = new Map<string, Set<string>>();
  private readonly work = new Map<string, WorkState>();
  private readonly evidence = new GrepEvidenceStore();
  private readonly notifications = new Set<() => void>();
  private runtimeFailed = false;

  private readonly onAbort = () => this.evidence.releaseAll();

  constructor(private readonly signal: AbortSignal = AbortSignal.timeout(30_000)) {
    this.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  get pendingEvidenceCount(): number { return this.evidence.size; }
  get hasRuntimeFailure(): boolean { return this.runtimeFailed; }
  get pendingRuntimeMutations(): number {
    return [...this.work.values()].filter((state) => state.terminal === undefined && statefulWork.has(state.start.work)).length;
  }

  run<T>(requestId: string, work: () => Promise<T>): Promise<T> {
    if (!this.events.has(requestId)) this.events.set(requestId, []);
    return withObservationContext({ requestId, phaseId: 'request' }, work);
  }

  captureGrepResults(context: ObservationContext, matches: readonly GrepMatch[]): GrepEvidenceRef {
    if (this.signal.aborted) throw new EvidenceUnavailableError();
    return this.evidence.capture(context, matches);
  }

  private fail(requestId: string, code: string): void {
    const failures = this.failures.get(requestId) ?? new Set<string>();
    failures.add(code);
    this.failures.set(requestId, failures);
  }

  onEvent(event: RuntimeEvent): void {
    if (event.kind === 'compaction_failed' || (event.kind === 'work_finished' && statefulWork.has(event.work) &&
      event.outcome !== 'success' && event.outcome !== 'already_running')) this.runtimeFailed = true;
    const requestId = event.context?.requestId;
    if (requestId === undefined) { this.notify(); return; }
    const events = this.events.get(requestId) ?? [];
    events.push(event);
    this.events.set(requestId, events);
    switch (event.kind) {
      case 'work_started': {
        if (this.work.has(event.workId)) { this.fail(requestId, 'duplicate_start'); break; }
        let resolve = () => {};
        const completion = new Promise<void>((finish) => { resolve = finish; });
        this.work.set(event.workId, { start: event, requestId, completion, resolve });
        break;
      }
      case 'work_finished': {
        const state = this.work.get(event.workId);
        if (state === undefined) { this.fail(requestId, 'terminal_without_start'); break; }
        if (state.terminal !== undefined) this.fail(requestId, 'duplicate_terminal');
        if (state.requestId !== requestId) this.fail(requestId, 'wrong_request_terminal');
        state.terminal = event;
        state.resolve();
        if (event.outcome !== 'success' && event.outcome !== 'already_running') this.fail(requestId, 'work_failed');
        break;
      }
      case 'reindex_finished':
        switch (event.outcome.status) {
          case 'fulfilled': break;
          case 'already_running':
            if (!event.outcome.ownerWorkId) { this.runtimeFailed = true; this.fail(requestId, 'unowned_reindex'); }
            break;
          case 'rejected': case 'incomplete': this.runtimeFailed = true; this.fail(requestId, 'reindex_failed'); break;
          default: assertNever(event.outcome);
        }
        break;
      case 'grep_child_finished': if (event.outcome.status !== 'exited') this.fail(requestId, 'grep_child_failed'); break;
      case 'grep_results_captured': if (event.evidence === undefined) this.fail(requestId, 'missing_evidence'); break;
      case 'grep_invalid_match': this.fail(requestId, 'grep_parser_failure'); break;
      case 'grep_signal': this.fail(requestId, 'grep_aborted'); break;
      case 'compaction_failed': this.fail(requestId, 'compaction_failed'); break;
      case 'drain_state': case 'queue_state': if (event.dropped > 0) this.fail(requestId, 'dropped_events'); break;
      case 'state_changed': break;
      case 'cache_lookup': if (event.input.keyDigest === undefined || event.input.origin === undefined) this.fail(requestId, 'missing_cache_identity'); break;
      case 'embedding_batch_submitted':
        if (event.entries.some((input) => input.origin === undefined || input.keyDigest === undefined)) this.fail(requestId, 'missing_cache_identity');
        break;
      case 'embedding_batch_finished': if (event.outcome === 'rejected') this.fail(requestId, 'embedding_failed'); break;
      default: assertNever(event);
    }
    this.notify();
  }

  private notify(): void { for (const notify of this.notifications) notify(); }

  waitUntil(predicate: () => boolean, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(observationError(signal.reason));
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.notifications.delete(check); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(observationError(signal.reason)); };
      const check = () => {
        try { if (predicate()) { cleanup(); resolve(); } }
        catch (error) { cleanup(); reject(observationError(error)); }
      };
      this.notifications.add(check);
      signal.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  successfulReindexes(requestId: string): readonly Readonly<ReindexResult>[] {
    return (this.events.get(requestId) ?? []).flatMap((event) =>
      event.kind === 'reindex_finished' && event.outcome.status === 'fulfilled' ? [event.outcome.result] : []);
  }

  reindexWallMs(requestId: string): number | undefined {
    const latest = (this.events.get(requestId) ?? []).findLast((event) => event.kind === 'reindex_finished' && event.outcome.status === 'fulfilled');
    const state = latest === undefined ? undefined : this.work.get(latest.workId);
    return state?.terminal === undefined ? undefined : state.terminal.time - state.start.time;
  }

  grepEvidence(requestId: string, stage: 'direct' | 'hybrid'): GrepEvidenceRef | undefined {
    const captures = (this.events.get(requestId) ?? []).filter((event) => event.kind === 'grep_results_captured' && event.stage === stage);
    if (captures.length !== 1) return undefined;
    const event = captures[0];
    return event?.kind === 'grep_results_captured' ? event.evidence : undefined;
  }

  cacheAccounting(requestId: string) { return summarizeCacheEvents(this.events.get(requestId) ?? []); }

  async seal(requestId: string): Promise<SealedOutcome> {
    const events = this.events.get(requestId) ?? [];
    const collectWork = () => {
      const owned = [...this.work.values()].filter((state) => state.requestId === requestId);
      const owners = events.flatMap((event) => event.kind === 'reindex_finished' && event.outcome.status === 'already_running' &&
        event.outcome.ownerWorkId !== undefined ? [this.work.get(event.outcome.ownerWorkId)] : []).filter((state) => state !== undefined);
      return { owned, required: [...owned, ...owners] };
    };
    let { owned, required } = collectWork();
    while (required.some((state) => state.terminal === undefined) && !this.signal.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          this.signal.removeEventListener('abort', finish);
          resolve();
        };
        this.signal.addEventListener('abort', finish, { once: true });
        void Promise.all(required.map((state) => state.completion)).then(finish);
      });
      ({ owned, required } = collectWork());
    }
    for (const failure of cacheAccountingFailures(events)) this.fail(requestId, failure);
    if (owned.length === 0) this.fail(requestId, 'missing_work');
    if (this.runtimeFailed) this.fail(requestId, 'runtime_failed');
    if (this.signal.aborted) this.fail(requestId, 'request_aborted');
    if (required.some((state) => state.terminal === undefined)) this.fail(requestId, 'missing_terminal');
    for (const state of required) {
      const sourceEvents = this.events.get(state.requestId) ?? [];
      if (state.start.work === 'reindex' && sourceEvents.filter((event) =>
        event.kind === 'reindex_finished' && event.workId === state.start.workId).length !== 1) {
        this.fail(requestId, 'missing_reindex_outcome');
      }
      if (state.start.work === 'grep_spawn' && sourceEvents.filter((event) =>
        event.kind === 'grep_child_finished' && event.workId === state.start.workId).length !== 1) {
        this.fail(requestId, 'missing_grep_child');
      }
      if (state.start.work === 'grep' || state.start.work === 'grep_branch') {
        const children = required.filter((child) => child.start.work === 'grep_spawn' &&
          this.descendsFrom(child.start.workId, state.start.workId));
        if (children.length !== 1) this.fail(requestId, 'missing_grep_child');
      }
    }
    for (const event of events) {
      if (event.kind === 'reindex_finished' && event.outcome.status === 'already_running') {
        const owner = event.outcome.ownerWorkId === undefined ? undefined : this.work.get(event.outcome.ownerWorkId);
        const ownerEvents = owner === undefined ? [] : this.events.get(owner.requestId) ?? [];
        if (owner?.terminal?.outcome !== 'success' || !ownerEvents.some((event) =>
          event.kind === 'reindex_finished' && event.workId === owner.start.workId && event.outcome.status === 'fulfilled') ||
          (owner !== undefined && (this.failures.get(owner.requestId)?.size ?? 0) > 0) ||
          cacheAccountingFailures(ownerEvents).length > 0) {
          this.fail(requestId, 'owner_not_successful');
        }
      }
    }
    const failures = [...(this.failures.get(requestId) ?? [])];
    const direct = this.grepEvidence(requestId, 'direct');
    const hybrid = this.grepEvidence(requestId, 'hybrid');
    const grepExecution = events.flatMap((event): GrepExecution[] => {
      if (event.kind !== 'grep_child_finished') return [];
      const started = this.work.get(event.workId)?.start.time;
      if (started === undefined) return [];
      return [{ wallMs: event.time - started,
        outcome: event.outcome.status === 'exited' ? event.outcome.exitCode === 0 ? 'exit_0' : 'exit_1' : event.outcome.status,
        exitCode: 'exitCode' in event.outcome ? event.outcome.exitCode : null, measurement: 'observed_child_wall_not_cpu' }];
    });
    return { status: failures.length === 0 ? 'valid' : 'invalid', failures, workCount: owned.length,
      grepExecution,
      workKinds: [...new Set(owned.map((state) => state.start.work))],
      ...((direct === undefined && hybrid === undefined) ? {} : { grepEvidence: {
        ...(direct === undefined ? {} : { direct }), ...(hybrid === undefined ? {} : { hybrid }),
      } }) };
  }

  private descendsFrom(childId: string, parentId: string): boolean {
    let current = this.work.get(childId)?.start.parentWorkId;
    for (let depth = 0; current !== undefined && depth < this.work.size; depth += 1) {
      if (current === parentId) return true;
      current = this.work.get(current)?.start.parentWorkId;
    }
    return false;
  }

  release(requestId: string): void {
    this.evidence.releaseRequest(requestId);
    this.events.delete(requestId);
    this.failures.delete(requestId);
    for (const [id, state] of this.work) if (state.requestId === requestId) this.work.delete(id);
  }

  releaseAll(): void {
    this.signal.removeEventListener('abort', this.onAbort);
    this.evidence.releaseAll();
    this.events.clear();
    this.work.clear();
    this.failures.clear();
    this.notifications.clear();
    this.runtimeFailed = false;
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { isAllowedCounterId, isAllowedUnit, isAllowedWorkKind } from './redaction.js';
import {
  diagnosticTraceEventSchema,
  diagnosticTraceIdentitySchema,
  operationIdSchema,
  attemptIdSchema,
  traceIncompleteReasonSchema,
  type DiagnosticErrorCategory,
  type DiagnosticSpanStatus,
  type DiagnosticStageId,
  type DiagnosticStateIntegrity,
  type DiagnosticTraceEvent,
  type DiagnosticTraceIdentity,
  type ProgressInput,
  type StageInput,
  type TraceIncompleteReason,
  type TraceClock,
  type TraceSnapshot,
} from './contracts.js';

type ActiveSpan = Readonly<{
  spanId: string;
  operationId: string;
  attemptId: string;
  stageId: DiagnosticStageId;
}>;

type CounterState = Readonly<{
  value: number;
  unit: string;
  semantics: ProgressInput['semantics'];
  expected: number | undefined;
}>;

type ResourceSampleFields = Omit<Extract<DiagnosticTraceEvent, { event: 'resource_sample' }>,
  keyof DiagnosticTraceIdentity | 'event' | 'schemaVersion' | 'seq' | 'monotonicNs'>;

const stateIntegrityPriority: Readonly<Record<DiagnosticStateIntegrity, number>> = {
  verified: 0,
  backup_cleanup_failed: 1,
  rollback_incomplete: 2,
  unknown: 3,
};

export class DiagnosticTraceRecorder {
  readonly #identity: DiagnosticTraceIdentity;
  readonly #clock: TraceClock;
  readonly #events: DiagnosticTraceEvent[] = [];
  readonly #context = new AsyncLocalStorage<ActiveSpan>();
  readonly #counterStates = new Map<string, CounterState>();
  readonly #lastProgressNs = new Map<string, bigint>();
  readonly #stateIntegrityBySpan = new Map<string, DiagnosticStateIntegrity>();
  readonly #incompleteReasons = new Set<TraceIncompleteReason>();
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  #recordedBytes = 0;
  #bytesDropped = 0;
  #flushedEvents = 0;
  #flushFailed = false;
  #finalized = false;
  #finalizing = false;
  #activeStages = 0;
  #flushChain: Promise<void> = Promise.resolve();
  #eventsDropped = 0;
  #sequence = 0;
  #spanSequence = 0;
  #lastRecordedMonotonicNs: bigint | undefined;

  markObserverFailure(): void {
    this.#markIncomplete('observer_failure');
  }

  markCleanupFailure(): void {
    this.#markIncomplete('cleanup_failure');
  }

  markStateIntegrity(stateIntegrity: DiagnosticStateIntegrity): void {
    const activeSpan = this.#context.getStore();
    if (activeSpan === undefined) {
      this.#markIncomplete('progress_outside_stage');
      return;
    }
    const previous = this.#stateIntegrityBySpan.get(activeSpan.spanId);
    if (previous === undefined || stateIntegrityPriority[stateIntegrity] > stateIntegrityPriority[previous]) {
      this.#stateIntegrityBySpan.set(activeSpan.spanId, stateIntegrity);
    }
  }

  recordResourceSample(sample: ResourceSampleFields): void {
    if (this.#finalized || this.#finalizing) {
      this.#markIncomplete('record_after_finalization');
      return;
    }
    const monotonicNs = this.#readMonotonicNs();
    const seq = this.#nextSequence();
    if (monotonicNs === undefined || seq === undefined) return;
    this.#append({ ...this.#identity, schemaVersion: 1, seq, monotonicNs, event: 'resource_sample', ...sample });
  }

  constructor(identity: DiagnosticTraceIdentity, clock: TraceClock, options: Readonly<{ maxEvents?: number; maxBytes?: number }> = {}) {
    this.#identity = diagnosticTraceIdentitySchema.parse(identity);
    this.#clock = clock;
    this.#maxEvents = Math.min(4095, Math.max(0, Math.floor(options.maxEvents ?? 4095)));
    this.#maxBytes = Math.min(8 * 1024 * 1024, Math.max(0, Math.floor(options.maxBytes ?? 8 * 1024 * 1024)));
    if (!Number.isSafeInteger(this.#maxEvents) || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < this.#terminalReserve('0')) {
      throw new RangeError('Invalid diagnostic trace limits');
    }
  }

  async withStage<T>(input: StageInput, work: () => T | Promise<T>): Promise<T> {
    if (this.#finalized || this.#finalizing) {
      this.#markIncomplete('record_after_finalization');
      return await this.#context.exit(work);
    }
    if (!operationIdSchema.safeParse(input.operationId).success || !attemptIdSchema.safeParse(input.attemptId).success) {
      this.#markIncomplete('event_validation_failed');
      return await this.#context.exit(work);
    }
    this.#activeStages += 1;
    try {
      return await this.#runStage(input, work);
    } finally {
      this.#activeStages -= 1;
    }
  }

  async #runStage<T>(input: StageInput, work: () => T | Promise<T>): Promise<T> {
    const workKind = input.workKind !== undefined && isAllowedWorkKind(input.workKind) ? input.workKind : undefined;
    if (input.workKind !== undefined && workKind === undefined) this.#markIncomplete('event_validation_failed');
    const startMonotonicNs = this.#readMonotonicNs();
    if (this.#spanSequence >= Number.MAX_SAFE_INTEGER) {
      this.#markIncomplete('sequence_exhausted');
      return this.#context.run({
        spanId: `${this.#identity.pid}:${this.#identity.processStartTicks}:overflow`,
        operationId: input.operationId,
        attemptId: input.attemptId,
        stageId: input.stageId,
      }, async () => await work());
    }
    const spanId = `${this.#identity.pid}:${this.#identity.processStartTicks}:${++this.#spanSequence}`;
    const parent = this.#context.getStore();
    const activeSpan: ActiveSpan = {
      spanId,
      operationId: input.operationId,
      attemptId: input.attemptId,
      stageId: input.stageId,
    };

    const sequence = this.#nextSequence();
    if (startMonotonicNs !== undefined && sequence !== undefined) {
      this.#append({
        ...this.#identity,
        schemaVersion: 1,
        seq: sequence,
        monotonicNs: startMonotonicNs,
        event: 'span_started',
        spanId,
        ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
        operationId: input.operationId,
        attemptId: input.attemptId,
        stageId: input.stageId,
        ...(workKind === undefined ? {} : { workKind }),
      });
    }

    return this.#context.run(activeSpan, async () => {
      try {
        const result = await work();
        this.#finishSpan(activeSpan, startMonotonicNs, 'completed');
        return result;
      } catch (error: unknown) {
        const category = this.#errorCategory(error);
        const status = category === 'abort_error'
          ? 'aborted'
          : category === 'timeout_error'
            ? 'timed_out'
            : 'failed';
        this.#finishSpan(activeSpan, startMonotonicNs, status, category);
        throw error;
      }
    });
  }

  progress(input: ProgressInput): void {
    if (!isAllowedCounterId(input.counterId) || !isAllowedUnit(input.unit)) {
      this.#markIncomplete('counter_contract_violation');
      return;
    }
    const activeSpan = this.#context.getStore();
    if (activeSpan === undefined) {
      this.#markIncomplete('progress_outside_stage');
      return;
    }

    if (!Number.isSafeInteger(input.value) || input.value < 0
      || (input.expected !== undefined && (!Number.isSafeInteger(input.expected) || input.expected < input.value))) {
      this.#markIncomplete('counter_contract_violation');
      return;
    }

    const stateKey = [
      this.#identity.runId,
      this.#identity.jobId,
      activeSpan.operationId,
      activeSpan.attemptId,
      activeSpan.stageId,
      input.counterId,
    ].join('\u0000');
    const previous = this.#counterStates.get(stateKey);
    const expected = input.expected;
    if (previous !== undefined && (
      (input.semantics !== 'pending' && input.value < previous.value)
      || input.unit !== previous.unit
      || input.semantics !== previous.semantics
      || expected !== previous.expected
    )) {
      this.#markIncomplete('counter_contract_violation');
      return;
    }

    const monotonicNs = this.#readMonotonicNs();
    if (monotonicNs === undefined) return;
    const timestamp = BigInt(monotonicNs);
    const lastProgress = this.#lastProgressNs.get(stateKey);
    if ((this.#lastRecordedMonotonicNs !== undefined && timestamp < this.#lastRecordedMonotonicNs)
      || (lastProgress !== undefined && timestamp < lastProgress)) {
      this.#markIncomplete('clock_regressed');
      return;
    }
    if (input.sampleReason !== 'stage_end' && lastProgress !== undefined && timestamp - lastProgress < 5_000_000_000n) {
      this.#counterStates.set(stateKey, { value: input.value, unit: input.unit, semantics: input.semantics, expected });
      return;
    }
    const sequence = this.#nextSequence();
    if (sequence === undefined) return;
    const event: DiagnosticTraceEvent = {
      ...this.#identity,
      schemaVersion: 1,
      seq: sequence,
      monotonicNs,
      event: 'progress',
      spanId: activeSpan.spanId,
      operationId: activeSpan.operationId,
      attemptId: activeSpan.attemptId,
      counterId: input.counterId,
      value: input.value,
      unit: input.unit,
      ...(expected === undefined ? {} : { expected }),
      semantics: input.semantics,
      sampleReason: input.sampleReason,
    };
    if (this.#append(event)) {
      this.#lastProgressNs.set(stateKey, timestamp);
      this.#counterStates.set(stateKey, {
        value: input.value,
        unit: input.unit,
        semantics: input.semantics,
        expected,
      });
    }
  }

  snapshot(): TraceSnapshot {
    const events: DiagnosticTraceEvent[] = [...this.#events];
    const reasonCode = this.#incompleteReasons.values().next().value;
    if (this.#sequence < Number.MAX_SAFE_INTEGER) {
      events.push({
        ...this.#identity,
        schemaVersion: 1,
        seq: this.#sequence + 1,
        monotonicNs: (this.#lastRecordedMonotonicNs ?? 0n).toString(),
        event: 'trace_status',
        finalizationState: 'provisional',
        traceIncomplete: reasonCode !== undefined,
        traceTruncated: this.#eventsDropped > 0,
        samplingIncomplete: reasonCode !== undefined,
        diagnosticAdmissible: false,
        eventsDropped: this.#eventsDropped,
        bytesDropped: this.#bytesDropped,
        profilesMissing: 0,
        profilesMissingExact: true,
        stateIntegrity: 'unknown',
        reasonCodes: [...this.#incompleteReasons],
        ...(reasonCode === undefined ? {} : { reasonCode }),
      });
    }
    return Object.freeze({
      events: Object.freeze(events),
      traceIncomplete: this.#incompleteReasons.size > 0,
      incompleteReasons: Object.freeze([...this.#incompleteReasons]),
      traceTruncated: this.#eventsDropped > 0,
      eventsDropped: this.#eventsDropped,
      bytesDropped: this.#bytesDropped,
    });
  }

  withoutCurrentSpan<T>(work: () => T): T {
    return this.#context.exit(work);
  }

  async flush(writer: Readonly<{ write: (content: string) => Promise<void> }>, options: Readonly<{ final: boolean }> = { final: true }): Promise<void> {
    const next = this.#flushChain.then(async () => await this.#flushNow(writer, options));
    this.#flushChain = next;
    await next;
  }

  async #flushNow(writer: Readonly<{ write: (content: string) => Promise<void> }>, options: Readonly<{ final: boolean }>): Promise<void> {
    if (this.#flushFailed || this.#finalized) return;
    if (options.final && this.#activeStages > 0) {
      this.#markIncomplete('finalization_with_active_spans');
      return;
    }
    const pending = this.#events.slice(this.#flushedEvents);
    const currentStatus = options.final ? this.snapshot().events.at(-1) : undefined;
    const status = currentStatus?.event === 'trace_status'
      ? { ...currentStatus, traceIncomplete: true, samplingIncomplete: true, reasonCode: 'finalization_unverified' as const,
        reasonCodes: [...new Set([...currentStatus.reasonCodes, 'finalization_unverified' as const])] }
      : undefined;
    const events = status === undefined ? pending : [...pending, status];
    const jsonl = events.map((event) => `${JSON.stringify(event)}\n`).join('');
    if (jsonl.length === 0) return;
    this.#finalizing = options.final;
    try {
      await writer.write(jsonl);
      this.#flushedEvents += pending.length;
      this.#finalized = options.final;
    } catch {
      this.#flushFailed = true;
      this.#markIncomplete('write_error');
    } finally {
      this.#finalizing = false;
    }
  }

  #finishSpan(
    span: ActiveSpan,
    startMonotonicNs: string | undefined,
    status: DiagnosticSpanStatus,
    errorCategory?: DiagnosticErrorCategory,
  ): void {
    const endMonotonicNs = this.#readMonotonicNs();
    if (startMonotonicNs === undefined || endMonotonicNs === undefined) {
      return;
    }
    const elapsedNs = BigInt(endMonotonicNs) - BigInt(startMonotonicNs);
    if (elapsedNs < 0n) {
      this.#markIncomplete('clock_regressed');
      return;
    }
    const sequence = this.#nextSequence();
    if (sequence === undefined) return;
    const stateIntegrity = this.#stateIntegrityBySpan.get(span.spanId);
    this.#stateIntegrityBySpan.delete(span.spanId);
    this.#append({
      ...this.#identity,
      schemaVersion: 1,
      seq: sequence,
      monotonicNs: endMonotonicNs,
      event: 'span_finished',
      spanId: span.spanId,
      operationId: span.operationId,
      attemptId: span.attemptId,
      stageId: span.stageId,
      status,
      endMonotonicNs,
      elapsedNs: elapsedNs.toString(),
      ...(errorCategory === undefined ? {} : { errorCategory }),
      ...(stateIntegrity === undefined ? {} : { stateIntegrity }),
    });
  }

  #readMonotonicNs(): string | undefined {
    try {
      const value = this.#clock.nowNs();
      if (value < 0n) {
        this.#markIncomplete('clock_unavailable');
        return undefined;
      }
      return value.toString();
    } catch (error: unknown) {
      this.#markIncomplete(error instanceof Error ? 'clock_unavailable' : 'clock_failure');
      return undefined;
    }
  }

  #append(event: DiagnosticTraceEvent): boolean {
    const parsed = diagnosticTraceEventSchema.safeParse(event);
    if (!parsed.success) {
      this.#markIncomplete('event_validation_failed');
      return false;
    }
    const eventMonotonicNs = BigInt(parsed.data.monotonicNs);
    if (this.#lastRecordedMonotonicNs !== undefined && eventMonotonicNs < this.#lastRecordedMonotonicNs) {
      this.#markIncomplete('clock_regressed');
      return false;
    }
    const eventBytes = Buffer.byteLength(`${JSON.stringify(parsed.data)}\n`);
    const terminalReserve = this.#terminalReserve(parsed.data.monotonicNs);
    if (this.#events.length >= this.#maxEvents || this.#recordedBytes + eventBytes + terminalReserve > this.#maxBytes) {
      this.#eventsDropped += 1;
      this.#bytesDropped += eventBytes;
      this.#markIncomplete(this.#events.length >= this.#maxEvents ? 'event_cap_exceeded' : 'byte_cap_exceeded');
      return false;
    }
    this.#events.push(parsed.data);
    this.#recordedBytes += eventBytes;
    this.#lastRecordedMonotonicNs = eventMonotonicNs;
    return true;
  }

  #terminalReserve(monotonicNs: string): number {
    return Buffer.byteLength(`${JSON.stringify({
      ...this.#identity, schemaVersion: 1, seq: Number.MAX_SAFE_INTEGER,
      monotonicNs, event: 'trace_status', finalizationState: 'provisional',
      traceIncomplete: true, diagnosticAdmissible: false,
      traceTruncated: true, samplingIncomplete: true,
      eventsDropped: Number.MAX_SAFE_INTEGER, bytesDropped: Number.MAX_SAFE_INTEGER,
      profilesMissing: Number.MAX_SAFE_INTEGER, profilesMissingExact: false, stateIntegrity: 'backup_cleanup_failed',
      reasonCode: 'counter_contract_violation',
      reasonCodes: traceIncompleteReasonSchema.options,
    })}\n`);
  }

  #nextSequence(): number | undefined {
    if (this.#sequence >= Number.MAX_SAFE_INTEGER) {
      this.#markIncomplete('sequence_exhausted');
      return undefined;
    }
    this.#sequence += 1;
    return this.#sequence;
  }

  #markIncomplete(reason: TraceIncompleteReason): void {
    this.#incompleteReasons.add(reason);
  }

  #errorCategory(error: unknown): DiagnosticErrorCategory {
    if (error instanceof Error) {
      if (error.name === 'AbortError') return 'abort_error';
      if (error.name === 'TimeoutError') return 'timeout_error';
    }
    return 'unknown_error';
  }
}

export function createTraceRecorder(identity: DiagnosticTraceIdentity, clock: TraceClock, options?: Readonly<{ maxEvents?: number; maxBytes?: number }>): DiagnosticTraceRecorder {
  return new DiagnosticTraceRecorder(identity, clock, options);
}

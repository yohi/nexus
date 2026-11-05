import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { diagnosticTraceEventSchema, type DiagnosticTraceIdentity } from '../../../../benchmarks/performance/diagnostics/contracts.js';
import { createTraceRecorder } from '../../../../benchmarks/performance/diagnostics/trace-recorder.js';
import { createTraceFileWriter } from '../../../../benchmarks/performance/diagnostics/trace-writer.js';
import { ProfileBudget } from '../../../../benchmarks/performance/diagnostics/profile-budget.js';

const identity: DiagnosticTraceIdentity = {
  runId: '00000000-0000-4000-8000-000000000001',
  jobId: 'cold_initial_index',
  recipeDigest: 'a'.repeat(64),
  sourceFingerprint: 'b'.repeat(64),
  pid: 1234,
  processStartTicks: '4567',
  ppid: 1200,
  processRole: 'vitest_worker',
  clockDomain: 'process_local_monotonic',
};

function createClock(): () => bigint {
  let currentNs = 1_000n;
  return () => {
    const sample = currentNs;
    currentNs += 1_000n;
    return sample;
  };
}

describe('diagnostic trace bounds', () => {
  it('rejects a diagnostic directory reached through a symlink ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-trace-test-'));
    try {
      const actual = join(root, 'actual');
      const directory = join(actual, 'run');
      await mkdir(actual, { mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      await symlink(actual, join(root, 'alias'));
      const writer = createTraceFileWriter(join(root, 'alias', 'run'), identity);
      try {
        await expect(writer.write('private\n')).rejects.toThrow();
      } finally {
        await writer.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves every incomplete reason in the persisted status', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() }, { maxEvents: 1 });
    const writes: string[] = [];
    const writer = { write: (content: string) => { writes.push(content); return Promise.resolve(); } };
    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => target.progress({ counterId: 'unsafe_counter', value: 1, unit: 'files', semantics: 'succeeded', sampleReason: 'threshold' }),
    );
    await target.flush(writer);
    const events = writes.join('').trim().split('\n').map((line): unknown => JSON.parse(line));
    const status = diagnosticTraceEventSchema.parse(events.at(-1));
    expect(status.event).toBe('trace_status');
    if (status.event !== 'trace_status') throw new Error('Expected trace status');
    expect(status.reasonCodes).toContain('counter_contract_violation');
    expect(status.reasonCodes).toContain('event_cap_exceeded');
    expect(status.reasonCodes).toContain('finalization_unverified');
  });

  it('marks diagnostics incomplete if a stage starts while final status is being written', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const writes: string[] = [];
    const writer = { write: async (content: string) => { writes.push(content); entered?.(); await blocked; } };
    const finalization = target.flush(writer);
    await started;
    const result = await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => 42,
    );
    release?.();
    await finalization;
    expect(result).toBe(42);
    expect(target.snapshot().traceIncomplete).toBe(true);
    const events = writes.join('').trim().split('\n').map((line): unknown => JSON.parse(line));
    expect(diagnosticTraceEventSchema.parse(events.at(-1))).toMatchObject({
      event: 'trace_status', finalizationState: 'provisional', traceIncomplete: true, reasonCode: 'finalization_unverified',
    });
  });

  it('does not finalize a trace while a stage remains active', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    const writes: string[] = [];
    const writer = { write: (content: string) => { writes.push(content); return Promise.resolve(); } };
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const work = target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      async () => { await blocked; return 42; },
    );
    await target.flush(writer);
    expect(writes.join('')).not.toContain('trace_status');
    expect(target.snapshot().traceIncomplete).toBe(true);
    release?.();
    expect(await work).toBe(42);
  });

  it('marks diagnostics incomplete when work is recorded after finalization', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    const writer = { write: () => Promise.resolve() };
    await target.flush(writer);
    const result = await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => 42,
    );
    expect(result).toBe(42);
    expect(target.snapshot().traceIncomplete).toBe(true);
  });

  it('serializes overlapping flush requests without duplicate events', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    const writes: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const writer = { write: async (content: string) => { writes.push(content); await blocked; } };
    await target.withStage({ stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' }, () => undefined);
    const first = target.flush(writer, { final: false });
    const second = target.flush(writer, { final: true });
    release?.();
    await Promise.all([first, second]);
    const parsed = writes.join('').trim().split('\n').map((line): unknown => JSON.parse(line)).map((event) => diagnosticTraceEventSchema.parse(event));
    expect(new Set(parsed.map((event) => event.seq)).size).toBe(parsed.length);
    expect(parsed.filter((event) => event.event === 'trace_status')).toHaveLength(1);
  });

  it('flushes only new events before writing a single terminal status', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    const writes: string[] = [];
    const writer = { write: (content: string) => { writes.push(content); return Promise.resolve(); } };
    const input = { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' } as const;
    await target.withStage(input, () => undefined);
    await target.flush(writer, { final: false });
    await target.withStage(input, () => undefined);
    await target.flush(writer, { final: true });
    const events: unknown[] = writes.join('').trim().split('\n').map((line): unknown => JSON.parse(line));
    const parsed = events.map((event) => diagnosticTraceEventSchema.parse(event));
    expect(parsed.filter((event) => event.event === 'span_started')).toHaveLength(2);
    expect(parsed.filter((event) => event.event === 'span_finished')).toHaveLength(2);
    expect(parsed.filter((event) => event.event === 'trace_status')).toHaveLength(1);
    expect(new Set(parsed.map((event) => event.seq)).size).toBe(parsed.length);
  });

  it('rejects profile segments beyond the segment and run byte ceilings', () => {
    const budget = new ProfileBudget();
    const mib = 1024 * 1024;
    expect(budget.reserve(64 * mib + 1)).toBe(false);
    for (let i = 0; i < 8; i += 1) expect(budget.reserve(64 * mib)).toBe(true);
    expect(budget.reserve(1)).toBe(false);
    expect(budget.snapshot()).toMatchObject({ bytesReserved: 512 * mib, profilesMissing: 2 });
  });

  it('rejects unsafe operation identifiers at the event schema boundary', () => {
    const event = {
      ...identity, schemaVersion: 1, seq: 1, monotonicNs: '1', event: 'span_started',
      spanId: '1234:4567:1', operationId: 'private_source_text', attemptId: 'attempt_1', stageId: 'S05_directory_scan',
    };
    expect(diagnosticTraceEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects non-allowlisted job names at the event schema boundary', () => {
    const event = {
      ...identity, jobId: 'private_query_text', schemaVersion: 1, seq: 1, monotonicNs: '1', event: 'span_started',
      spanId: '1234:4567:1', operationId: 'op_0000000000000001', attemptId: 'attempt_1', stageId: 'S05_directory_scan',
    };
    expect(diagnosticTraceEventSchema.safeParse(event).success).toBe(false);
  });

  it('emits the next progress sample exactly five seconds after the previous one', async () => {
    const values = [1n, 100n, 5_000_000_099n, 5_000_000_100n, 5_000_000_101n];
    let index = 0;
    const target = createTraceRecorder(identity, { nowNs: () => values[index++] ?? 5_000_000_101n });
    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => {
        for (const value of [1, 2, 3]) target.progress({ counterId: 'scan.files_emitted', value, unit: 'files', semantics: 'succeeded', sampleReason: 'interval' });
      },
    );
    expect(target.snapshot().events.flatMap((event) => event.event === 'progress' ? [event.value] : [])).toEqual([1, 3]);
  });

  it('includes a non-admissible status when no losses occurred but integrity is unverified', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => undefined,
    );
    expect(target.snapshot().events.at(-1)).toMatchObject({
      event: 'trace_status', traceIncomplete: false, diagnosticAdmissible: false, stateIntegrity: 'unknown',
    });
  });

  it('does not serialize extra path, source, query, embedding, error, or environment fields', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    const extra = { path: '/private/path', source: 'secret_source', query: 'secret_query', embedding: [0.5], error: 'secret_error', env: 'secret_env' };
    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1', ...extra },
      () => target.progress({ counterId: 'scan.files_emitted', value: 1, unit: 'files', semantics: 'succeeded', sampleReason: 'stage_end', ...extra }),
    );
    const serialized = JSON.stringify(target.snapshot());
    for (const value of ['/private/path', 'secret_source', 'secret_query', 'secret_error', 'secret_env', 'embedding']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('does not serialize source-like operation or attempt identities', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    const result = await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'private_source_text', attemptId: 'private_query_text' },
      () => 42,
    );
    expect(result).toBe(42);
    expect(JSON.stringify(target.snapshot())).not.toContain('private_source_text');
    expect(JSON.stringify(target.snapshot())).not.toContain('private_query_text');
    expect(target.snapshot().traceIncomplete).toBe(true);
  });

  it('omits unrecognized work kind strings without changing the stage result', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    const result = await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1', workKind: 'private_source_text' },
      () => 42,
    );
    expect(result).toBe(42);
    expect(JSON.stringify(target.snapshot())).not.toContain('private_source_text');
    expect(target.snapshot().traceIncomplete).toBe(true);
  });

  it('refuses to write into a directory that is not private', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-trace-test-'));
    try {
      await chmod(directory, 0o755);
      await expect(createTraceFileWriter(directory, identity).write('secret\n')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('allows a pending gauge to decrease at stage end', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    await target.withStage(
      { stageId: 'S09_index_settlement', operationId: 'op_0000000000000007', attemptId: 'attempt_1' },
      () => {
        target.progress({ counterId: 'settlement.queue_pending', value: 2, unit: 'items', semantics: 'pending', sampleReason: 'threshold' });
        target.progress({ counterId: 'settlement.queue_pending', value: 0, unit: 'items', semantics: 'pending', sampleReason: 'stage_end' });
      },
    );
    const snapshot = target.snapshot();
    expect(snapshot.traceIncomplete).toBe(false);
    expect(snapshot.events.flatMap((event) => event.event === 'progress' ? [event.value] : [])).toEqual([2, 0]);
  });

  it('creates a private trace file exclusively inside the owned directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-trace-test-'));
    try {
      const writer = createTraceFileWriter(directory, identity);
      await writer.write('one\n');
      await writer.write('two\n');
      await expect(createTraceFileWriter(directory, identity).write('overwrite\n')).rejects.toThrow();
      await writer.close();
      const file = join(directory, 'trace-1234-4567.jsonl');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, 'utf8')).toBe('one\ntwo\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects arbitrary unit strings instead of serializing them', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => target.progress({ counterId: 'scan.files_emitted', value: 1, unit: 'private_value', semantics: 'succeeded', sampleReason: 'threshold' }),
    );
    expect(JSON.stringify(target.snapshot())).not.toContain('private_value');
    expect(target.snapshot().traceIncomplete).toBe(true);
  });

  it('rejects unknown counter names instead of recording source-like strings', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => target.progress({ counterId: 'private_source_text', value: 1, unit: 'files', semantics: 'succeeded', sampleReason: 'threshold' }),
    );

    const snapshot = target.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain('private_source_text');
    expect(snapshot.traceIncomplete).toBe(true);
  });

  it('preserves a stage result and original exception when the writer fails', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    const writer = { write: () => Promise.reject(new Error('private writer detail')) };
    const input = { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' } as const;
    const failure = new Error('original error');

    const result = await target.withStage(input, () => 17);
    await target.flush(writer);
    await expect(target.withStage(input, () => { throw failure; })).rejects.toBe(failure);
    await target.flush(writer);

    expect(result).toBe(17);
    expect(target.snapshot().incompleteReasons).toContain('write_error');
    expect(target.snapshot().events.at(-1)).toMatchObject({ event: 'trace_status', reasonCode: 'write_error', traceIncomplete: true });
    expect(JSON.stringify(target.snapshot())).not.toContain('private writer detail');
  });

  it('rejects a clock regression even when the progress sample would be coalesced', async () => {
    const values = [100n, 200n, 300n, 250n, 400n];
    let index = 0;
    const target = createTraceRecorder(identity, { nowNs: () => values[index++] ?? 400n });
    const progress = (counterId: string) => target.progress({
      counterId, value: 1, unit: 'files', semantics: 'succeeded', sampleReason: 'threshold',
    });

    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => { progress('scan.files_emitted'); progress('scan.directories_visited'); progress('scan.files_emitted'); },
    );

    expect(target.snapshot().incompleteReasons).toContain('clock_regressed');
  });

  it('keeps a million updates to one counter within the event ceiling', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => {
        for (let value = 0; value < 1_000_000; value += 1) {
          target.progress({ counterId: 'scan.files_emitted', value, unit: 'files', semantics: 'succeeded', sampleReason: 'threshold' });
        }
      },
    );

    const snapshot = target.snapshot();
    expect(snapshot.events.length).toBeLessThanOrEqual(4096);
    expect(snapshot.traceIncomplete).toBe(false);
  });

  it('coalesces frequent progress but retains the final stage counter', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() });
    const progress = (value: number, sampleReason: 'threshold' | 'stage_end') => target.progress({
      counterId: 'scan.files_emitted', value, unit: 'files', semantics: 'succeeded', sampleReason,
    });

    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => { progress(1, 'threshold'); progress(2, 'threshold'); progress(3, 'stage_end'); },
    );

    const values = target.snapshot().events.flatMap((event) => event.event === 'progress' ? [event.value] : []);
    expect(values).toEqual([1, 3]);
  });

  it('rejects a byte budget too small to hold a terminal status', () => {
    expect(() => createTraceRecorder(identity, { nowNs: createClock() }, { maxBytes: 1 })).toThrow();
  });

  it('reserves space for a terminal status when the byte cap is reached', async () => {
    const maxBytes = 1600;
    const target = createTraceRecorder(identity, { nowNs: createClock() }, { maxBytes });

    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => undefined,
    );

    const snapshot = target.snapshot();
    const jsonl = snapshot.events.map((event) => `${JSON.stringify(event)}\n`).join('');
    expect(Buffer.byteLength(jsonl)).toBeLessThanOrEqual(maxBytes);
    expect(snapshot.events.at(-1)).toMatchObject({ event: 'trace_status', traceIncomplete: true });
    expect(snapshot.bytesDropped).toBeGreaterThan(0);
  });

  it('event_cap_sets_trace_truncated', async () => {
    const target = createTraceRecorder(identity, { nowNs: createClock() }, { maxEvents: 2 });

    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => undefined,
    );
    await target.withStage(
      { stageId: 'S06_parse_chunk', operationId: 'op_0000000000000006', attemptId: 'attempt_1' },
      () => undefined,
    );

    const snapshot = target.snapshot();
    expect(snapshot.events.filter((event) => event.event !== 'trace_status')).toHaveLength(2);
    expect(snapshot.traceTruncated).toBe(true);
    expect(snapshot.eventsDropped).toBeGreaterThan(0);
    expect(snapshot.events.at(-1)).toMatchObject({
      event: 'trace_status',
      traceIncomplete: true,
      diagnosticAdmissible: false,
      eventsDropped: 2,
      reasonCode: 'event_cap_exceeded',
      traceTruncated: true,
      samplingIncomplete: true,
    });
  });
});

import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseClockPingWindow } from '../../../../benchmarks/performance/diagnostics/clock-domain.js';
import { diagnosticTraceEventSchema } from '../../../../benchmarks/performance/diagnostics/contracts.js';

const hasPython = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 13) else 1)'], {
  stdio: 'ignore',
}).status === 0;

describe('versioned external diagnostics kit', () => {
  it('closes the acquired budget descriptor when identity inspection fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-profile-lock-fstat-'));
    try {
      const runDirectory = join(root, 'run');
      await mkdir(runDirectory, { mode: 0o700 });
      const sinkPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/profile-event-sink.cjs');
      const request = {
        schemaVersion: 1, diagnosticOnly: true, runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
        runDirectory, parentPid: process.pid,
      };
      const script = [
        "const fs = require('node:fs'); const original = fs.fstatSync;",
        `const sink = require(${JSON.stringify(sinkPath)}).createProfileEventSink(${JSON.stringify(request)});`,
        "const before = fs.readdirSync('/proc/self/fd').length;",
        "fs.fstatSync = (fd, ...args) => { if (fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/profile-budget.lock')) throw new Error('injected'); return original(fd, ...args); };",
        "sink.writeProfile('seg_000001', '{\"nodes\":[],\"samples\":[]}', 0);",
        "const after = fs.readdirSync('/proc/self/fd').length;",
        'sink.finalize(); process.stdout.write(JSON.stringify({ before, after }));',
      ].join('\n');
      const output = execFileSync('node', ['-e', script], { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' });
      const result = z.object({ before: z.number(), after: z.number() }).strict().parse(JSON.parse(output));
      expect(result.after).toBe(result.before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed without deleting an existing profile budget lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-profile-lock-'));
    try {
      const runDirectory = join(root, 'run');
      await mkdir(runDirectory, { mode: 0o700 });
      const lockPath = join(runDirectory, 'profile-budget.lock');
      await writeFile(lockPath, 'other owner', { mode: 0o600 });
      const sinkPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/profile-event-sink.cjs');
      const request = {
        schemaVersion: 1, diagnosticOnly: true, runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
        runDirectory, parentPid: process.pid,
      };
      const script = [
        `const sink = require(${JSON.stringify(sinkPath)}).createProfileEventSink(${JSON.stringify(request)});`,
        "sink.writeProfile('seg_000001', '{\"nodes\":[],\"samples\":[]}', 0);",
        'sink.finalize();',
      ].join('\n');
      execFileSync('node', ['-e', script], { env: { ...process.env, NODE_OPTIONS: '' } });
      expect(await readFile(lockPath, 'utf8')).toBe('other owner');
      expect(await readdir(join(runDirectory, 'profiles'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enforces the run-wide profile byte cap against files written by another process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-profile-run-cap-'));
    try {
      const runDirectory = join(root, 'run');
      const profiles = join(runDirectory, 'profiles');
      await mkdir(runDirectory, { mode: 0o700 });
      await mkdir(profiles, { mode: 0o700 });
      const existing = await open(join(profiles, 'existing.cpuprofile'), 'wx', 0o600);
      try {
        await existing.truncate(512 * 1024 * 1024);
      } finally {
        await existing.close();
      }
      const sinkPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/profile-event-sink.cjs');
      const request = {
        schemaVersion: 1, diagnosticOnly: true, runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
        runDirectory, parentPid: process.pid,
      };
      const script = [
        `const sink = require(${JSON.stringify(sinkPath)}).createProfileEventSink(${JSON.stringify(request)});`,
        "sink.writeProfile('seg_000001', '{\"nodes\":[],\"samples\":[]}', 0);",
        'sink.finalize();',
      ].join('\n');
      execFileSync('node', ['-e', script], { env: { ...process.env, NODE_OPTIONS: '' } });
      expect(await readdir(profiles)).toEqual(['existing.cpuprofile']);
      const filename = (await readdir(runDirectory)).find((entry) => entry.startsWith('profile-events-'));
      if (filename === undefined) throw new Error('Expected profile lifecycle events');
      const lines = (await readFile(join(runDirectory, filename), 'utf8')).trim().split('\n');
      const status = diagnosticTraceEventSchema.parse(JSON.parse(lines.at(-1) ?? '{}'));
      if (status.event !== 'trace_status') throw new Error('Expected terminal status');
      expect(status.profilesMissing).toBe(1);
      expect(status.reasonCodes).toContain('byte_cap_exceeded');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not count a successfully written profile as missing when its event is dropped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-profile-event-drop-'));
    try {
      const runDirectory = join(root, 'run');
      await mkdir(runDirectory, { mode: 0o700 });
      const sinkPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/profile-event-sink.cjs');
      const request = {
        schemaVersion: 1, diagnosticOnly: true, runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
        runDirectory, parentPid: process.pid,
      };
      const script = [
        `const sink = require(${JSON.stringify(sinkPath)}).createProfileEventSink(${JSON.stringify(request)});`,
        "for (let index = 0; index < 4095; index++) sink.append({ event: 'preload_started' });",
        "sink.writeProfile('seg_000001', '{\"nodes\":[],\"samples\":[]}', 0);",
        'sink.finalize();',
      ].join('\n');
      execFileSync('node', ['-e', script], { env: { ...process.env, NODE_OPTIONS: '' } });
      const filename = (await readdir(runDirectory)).find((entry) => entry.startsWith('profile-events-'));
      if (filename === undefined) throw new Error('Expected profile lifecycle events');
      const lines = (await readFile(join(runDirectory, filename), 'utf8')).trim().split('\n');
      const status = diagnosticTraceEventSchema.parse(JSON.parse(lines.at(-1) ?? '{}'));
      if (status.event !== 'trace_status') throw new Error('Expected terminal status');
      expect(status.eventsDropped).toBe(1);
      expect(status.profilesMissing).toBe(0);
      expect((await readdir(join(runDirectory, 'profiles'))).length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks missing profile counts inexact when the bounded identity set fills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-profile-overflow-'));
    try {
      const runDirectory = join(root, 'run');
      await mkdir(runDirectory, { mode: 0o700 });
      const sinkPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/profile-event-sink.cjs');
      const request = {
        schemaVersion: 1, diagnosticOnly: true, runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
        runDirectory, parentPid: process.pid,
      };
      const script = [
        `const sink = require(${JSON.stringify(sinkPath)}).createProfileEventSink(${JSON.stringify(request)});`,
        "for (let index = 0; index < 4095; index++) sink.append({ event: 'preload_started' });",
        "for (let index = 0; index < 4097; index++) sink.append({ event: 'profile_segment_start_failed', segmentId: 'seg_' + index, sampleCount: { status: 'not_collected', reasonCode: 'profile_missing' }, fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' }, errorCategory: 'observer_error' });",
        'sink.finalize();',
      ].join('\n');
      execFileSync('node', ['-e', script], { env: { ...process.env, NODE_OPTIONS: '' } });
      const filename = (await readdir(runDirectory)).find((entry) => entry.startsWith('profile-events-'));
      if (filename === undefined) throw new Error('Expected profile lifecycle events');
      const lines = (await readFile(join(runDirectory, filename), 'utf8')).trim().split('\n');
      const status = diagnosticTraceEventSchema.parse(JSON.parse(lines.at(-1) ?? '{}'));
      if (status.event !== 'trace_status') throw new Error('Expected terminal status');
      expect(status.profilesMissing).toBe(4096);
      expect(status.profilesMissingExact).toBe(false);
      expect(status.reasonCodes).toContain('missing_profile_count_overflow');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts a dropped profiler stop failure only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-profile-drop-'));
    try {
      const runDirectory = join(root, 'run');
      await mkdir(runDirectory, { mode: 0o700 });
      const sinkPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/profile-event-sink.cjs');
      const request = {
        schemaVersion: 1, diagnosticOnly: true, runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
        runDirectory, parentPid: process.pid,
      };
      const script = [
        `const sink = require(${JSON.stringify(sinkPath)}).createProfileEventSink(${JSON.stringify(request)});`,
        "for (let index = 0; index < 4095; index++) sink.append({ event: 'preload_started' });",
        "sink.append({ event: 'profile_segment_started', segmentId: 'seg_000001', sampleCount: { status: 'not_collected', reasonCode: 'not_yet_sampled' }, fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' } });",
        "sink.append({ event: 'profile_segment_stop_failed', segmentId: 'seg_000001', sampleCount: { status: 'not_collected', reasonCode: 'profile_missing' }, fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' }, errorCategory: 'observer_error' });",
        'sink.finalize();',
      ].join('\n');
      execFileSync('node', ['-e', script], { env: { ...process.env, NODE_OPTIONS: '' } });
      const filename = (await readdir(runDirectory)).find((entry) => entry.startsWith('profile-events-'));
      if (filename === undefined) throw new Error('Expected profile lifecycle events');
      const lines = (await readFile(join(runDirectory, filename), 'utf8')).trim().split('\n');
      const status = diagnosticTraceEventSchema.parse(JSON.parse(lines.at(-1) ?? '{}'));
      expect(status.event).toBe('trace_status');
      if (status.event !== 'trace_status') throw new Error('Expected terminal status');
      expect(status.eventsDropped).toBe(2);
      expect(status.profilesMissing).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes complete JSONL records when the filesystem writes only partial chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-profile-short-write-'));
    try {
      const runDirectory = join(root, 'run');
      await mkdir(runDirectory, { mode: 0o700 });
      const sinkPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/profile-event-sink.cjs');
      const request = {
        schemaVersion: 1, diagnosticOnly: true, runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
        runDirectory, parentPid: process.pid,
      };
      const script = [
        "const fs = require('node:fs'); const original = fs.writeSync;",
        'fs.writeSync = (fd, data, ...rest) => {',
        " const bytes = typeof data === 'string' ? Buffer.from(data) : data.subarray(rest[0], rest[0] + rest[1]);",
        ' const chunk = bytes.subarray(0, Math.min(17, bytes.length));',
        ' return original(fd, chunk, 0, chunk.length);',
        '};',
        `const sink = require(${JSON.stringify(sinkPath)}).createProfileEventSink(${JSON.stringify(request)});`,
        "sink.append({ event: 'preload_started' }); sink.finalize();",
      ].join('\n');
      execFileSync('node', ['-e', script], { env: { ...process.env, NODE_OPTIONS: '' } });
      const filename = (await readdir(runDirectory)).find((entry) => entry.startsWith('profile-events-'));
      if (filename === undefined) throw new Error('Expected profile lifecycle events');
      const events = (await readFile(join(runDirectory, filename), 'utf8')).trim().split('\n')
        .map((line): unknown => JSON.parse(line)).map((value) => diagnosticTraceEventSchema.parse(value));
      expect(events.map((event) => event.event)).toEqual(['preload_started', 'trace_status']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records profiler stop failure without claiming a file write was attempted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-profile-stop-'));
    try {
      const runDirectory = join(root, 'run');
      const requestPath = join(root, 'request.json');
      await mkdir(runDirectory, { mode: 0o700 });
      await writeFile(requestPath, JSON.stringify({
        schemaVersion: 1, diagnosticOnly: true, runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
        runDirectory, parentPid: process.pid,
      }), { mode: 0o600 });
      const preloadPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/worker_profile_preload.cjs');
      const script = [
        "const inspector = require('node:inspector');",
        'inspector.Session = class { connect() {} disconnect() {} post(method, params, cb) {',
        "  const done = typeof params === 'function' ? params : cb;",
        "  if (method === 'Profiler.stop') done(new Error('private detail'));",
        '  else done(null, {});',
        '} };',
        `require(${JSON.stringify(preloadPath)});`,
        "process.emit('beforeExit', 0);",
      ].join('\n');
      execFileSync('node', ['-e', script], {
        env: { ...process.env, NODE_OPTIONS: '', VITEST_WORKER_ID: '1', NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE: requestPath },
      });
      const filename = (await readdir(runDirectory)).find((entry) => entry.startsWith('profile-events-'));
      if (filename === undefined) throw new Error('Expected profile lifecycle events');
      const content = await readFile(join(runDirectory, filename), 'utf8');
      expect(content).toContain('"event":"profile_segment_stop_failed"');
      expect(content).not.toContain('"event":"profile_write_failed"');
      expect(content).not.toContain('private detail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes a complete profile lifecycle using an injected inspector without a benchmark worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-profile-preload-'));
    try {
      const runDirectory = join(root, 'run');
      const requestPath = join(root, 'request.json');
      await mkdir(runDirectory, { mode: 0o700 });
      await writeFile(requestPath, JSON.stringify({
        schemaVersion: 1, diagnosticOnly: true, runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
        runDirectory, parentPid: process.pid,
      }), { mode: 0o600 });
      const preloadPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/worker_profile_preload.cjs');
      const script = [
        "const inspector = require('node:inspector');",
        'inspector.Session = class { connect() {} disconnect() {} post(method, params, cb) {',
        "  const done = typeof params === 'function' ? params : cb;",
        "  if (method === 'Profiler.stop') done(null, { profile: { nodes: [], samples: [] } });",
        '  else done(null, {});',
        '} };',
        `require(${JSON.stringify(preloadPath)});`,
        "process.emit('beforeExit', 0);",
      ].join('\n');
      execFileSync('node', ['-e', script], {
        env: { ...process.env, NODE_OPTIONS: '', VITEST_WORKER_ID: '1', NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE: requestPath },
      });
      const filename = (await readdir(runDirectory)).find((entry) => entry.startsWith('profile-events-'));
      if (filename === undefined) throw new Error('Expected profile lifecycle events');
      const events = (await readFile(join(runDirectory, filename), 'utf8')).trim().split('\n')
        .map((line): unknown => JSON.parse(line)).map((value) => diagnosticTraceEventSchema.parse(value));
      expect(events.map((event) => event.event)).toEqual([
        'preload_started', 'profile_segment_started', 'profile_segment_stop_requested', 'profile_segment_stopped',
        'profile_write_completed', 'trace_status',
      ]);
      expect((await readdir(join(runDirectory, 'profiles'))).length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes bounded provisional profile events with private file modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-profile-sink-'));
    try {
      const runDirectory = join(root, 'run');
      const requestPath = join(root, 'request.json');
      await mkdir(runDirectory, { mode: 0o700 });
      await writeFile(requestPath, JSON.stringify({
        schemaVersion: 1,
        diagnosticOnly: true,
        runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index',
        recipeDigest: 'a'.repeat(64),
        sourceFingerprint: 'b'.repeat(64),
        runDirectory,
        parentPid: process.pid,
      }), { mode: 0o600 });
      await chmod(runDirectory, 0o700);
      await chmod(requestPath, 0o600);
      const sinkPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/profile-event-sink.cjs');
      const childSource = [
        `const sinkModule = require(${JSON.stringify(sinkPath)});`,
        'const sink = sinkModule.createProfileEventSink(sinkModule.loadDiagnosticRequest());',
        "sink.append({ event: 'profile_segment_started', segmentId: 'seg_000001', sampleCount: { status: 'not_collected', reasonCode: 'not_yet_sampled' }, fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' } });",
        'sink.finalize();',
      ].join('\n');
      const childEnv = { ...process.env, NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE: requestPath, NODE_OPTIONS: '' };
      execFileSync('node', ['-e', childSource], { env: childEnv });

      const files = await readdir(runDirectory);
      const eventFile = files.find((file) => file.startsWith('profile-events-'));
      expect(eventFile).toBeDefined();
      if (eventFile === undefined) throw new Error('Expected process-specific profile event file');
      expect((await stat(join(runDirectory, eventFile))).mode & 0o777).toBe(0o600);
      expect((await stat(join(runDirectory, 'profiles'))).mode & 0o777).toBe(0o700);
      const lines = (await readFile(join(runDirectory, eventFile), 'utf8')).trim().split('\n');
      expect(lines[0]).toContain('"event":"profile_segment_started"');
      expect(lines[0]).toContain('"pid":');
      expect(lines.at(-1)).toContain('"event":"trace_status"');
      expect(lines.at(-1)).toContain('"finalizationState":"provisional"');
      expect(lines.at(-1)).toContain('"traceIncomplete":true');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads no profiler and creates no profile directory without an explicit request', () => {
    const preloadPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/worker_profile_preload.cjs');
    expect(() => execFileSync('node', ['--check', preloadPath])).not.toThrow();
    const output = execFileSync('node', ['--require', preloadPath, '-e', "process.stdout.write('preload-noop')"], {
      encoding: 'utf8',
      env: { ...process.env, NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE: '', NODE_OPTIONS: '' },
    });
    expect(output).toBe('preload-noop');
  });

  it.skipIf(!hasPython)('runs a clock-only Node child handshake without starting a benchmark worker', () => {
    const nodeExecutable = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
    const output = execFileSync('python3', [
      join(process.cwd(), 'scripts/performance-diagnostics/v4/clock_conformance.py'),
      nodeExecutable,
      'start',
    ], { encoding: 'utf8', timeout: 10_000 });
    const outputSchema = z.object({
      phase: z.literal('start'),
      probePid: z.number().int().positive(),
      probeStartTicks: z.string().regex(/^[1-9][0-9]*$/),
      clockWindow: z.unknown(),
    }).strict();
    const result = outputSchema.parse(JSON.parse(output));
    const clock = parseClockPingWindow(result.clockWindow);
    expect(clock.pings.length).toBe(30);
    expect(clock.parentClockSource).toBe('time.clock_gettime_ns:CLOCK_MONOTONIC');
    expect(clock.childClockSource).toBe('process.hrtime.bigint');
  });

  it.skipIf(!hasPython)('summarizes profile samples without emitting raw source URLs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-profile-summary-'));
    try {
      const profilePath = join(directory, 'sample.cpuprofile');
      const outputPath = join(directory, 'summary.json');
      await writeFile(profilePath, JSON.stringify({
        nodes: [
          { id: 1, callFrame: { functionName: 'scan', url: '/workspace/src/indexer/pipeline.ts' } },
          { id: 2, callFrame: { functionName: 'query', url: '/workspace/private/source.ts' } },
        ],
        samples: [1, 1, 2],
      }));

      execFileSync('python3', [join(process.cwd(), 'scripts/performance-diagnostics/v4/summarize_profiles.py'), profilePath, outputPath]);
      const summary: unknown = JSON.parse(await readFile(outputPath, 'utf8'));
      const serialized = JSON.stringify(summary);
      expect(serialized).toContain('indexer');
      expect(serialized).toContain('other');
      expect(serialized).not.toContain('/workspace');
      expect(serialized).not.toContain('pipeline.ts');
      expect(serialized).not.toContain('source.ts');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasPython)('rejects a corrupt profile without writing a summary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-corrupt-profile-'));
    try {
      const profilePath = join(directory, 'corrupt.cpuprofile');
      const outputPath = join(directory, 'summary.json');
      await writeFile(profilePath, '{not-json');

      expect(() => execFileSync('python3', [join(process.cwd(), 'scripts/performance-diagnostics/v4/summarize_profiles.py'), profilePath, outputPath], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })).toThrow();
      await expect(readFile(outputPath, 'utf8')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

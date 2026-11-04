import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { prepareDiagnosticRun } from '../../../../../scripts/run-performance-diagnostic.mjs';

type VitestBootstrapModule = Readonly<{
  runDiagnosticVitestBootstrap: (
    input: Readonly<{
      environment: Record<string, string | undefined>;
      repository: string;
      pid: number;
      preloadPath: string;
      configPath: string;
      testEntryPath: string;
    }>,
    services: Readonly<{
      loadProfiler: (preloadPath: string) => void | Promise<void>;
      startVitest: (mode: 'test', filters: readonly string[], options: Readonly<Record<string, unknown>>) => Promise<unknown>;
      waitForSupervisorStart?: () => Promise<unknown>;
      readProcessIdentity?: (pid: number) => Promise<unknown>;
      getExitCode?: () => number | null | undefined;
    }>,
  ) => Promise<Readonly<{
    status: 'completed' | 'failed';
    runId: string;
    profileRequestFile: string;
    statusFile: string;
    exitCode: number;
  }>>;
}>;

function isVitestBootstrapModule(value: unknown): value is VitestBootstrapModule {
  return typeof value === 'object' && value !== null
    && 'runDiagnosticVitestBootstrap' in value && typeof value.runDiagnosticVitestBootstrap === 'function';
}

async function loadVitestBootstrap(): Promise<VitestBootstrapModule> {
  const moduleUrl = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/diagnostic-vitest-bootstrap.mjs')).href;
  let loaded: unknown;
  try {
    loaded = await import(moduleUrl);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isVitestBootstrapModule(loaded)).toBe(true);
  if (!isVitestBootstrapModule(loaded)) throw new Error('diagnostic_vitest_bootstrap_missing');
  return loaded;
}

const runId = '00000000-0000-4000-8000-000000000001';
const sourceFingerprint = 'b'.repeat(64);
const roots: string[] = [];

async function prepareRun() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-bootstrap-'));
  roots.push(root);
  const prepared = await prepareDiagnosticRun({ diagnosticsRoot: join(root, 'diagnostics') }, {
    repository: process.cwd(),
    runId,
    sourceMetadata: () => Promise.resolve({
      revision: { commit: 'c'.repeat(40), dirty: false },
      environment: { sourceFingerprint },
    }),
    diagnosticFingerprint: () => Promise.resolve({ digest: sourceFingerprint }),
  });
  const profileRequestFile = join(prepared.traceDirectory, 'profile-request.json');
  const environment: Record<string, string | undefined> = {
    NODE_OPTIONS: '',
    NEXUS_PERF_REQUEST_FILE: prepared.workerRequestFile,
    NEXUS_PERF_WORKER_DIAGNOSTIC_REQUEST_FILE: prepared.workerDiagnosticRequestFile,
    NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE: profileRequestFile,
  };
  return { prepared, profileRequestFile, environment };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const profileRequestSchema = z.object({
  schemaVersion: z.literal(1),
  diagnosticOnly: z.literal(true),
  runId: z.string().uuid(),
  jobId: z.literal('cold_initial_index'),
  recipeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runDirectory: z.string(),
  parentPid: z.number().int().positive(),
}).strict();
const bootstrapResultSchema = z.object({
  schemaVersion: z.literal(1),
  diagnosticOnly: z.literal(true),
  runId: z.string().uuid(),
  jobId: z.literal('cold_initial_index'),
  status: z.enum(['completed', 'failed']),
  exitCode: z.number().int(),
  diagnosticAdmissible: z.literal(false),
}).strict();

it('writes_parent_identity_and_loads_profiler_before_starting_only_the_diagnostic_test', async () => {
  const bootstrap = await loadVitestBootstrap();
  const { prepared, profileRequestFile, environment } = await prepareRun();
  const statusFile = join(prepared.runDirectory, 'diagnostic-status.json');
  const calls: string[] = [];
  const preloadPath = join(process.cwd(), 'scripts/performance-diagnostics/v4/worker_profile_preload.cjs');
  const configPath = join(process.cwd(), 'vitest.diagnostic-performance.config.ts');
  const testEntryPath = join(process.cwd(), 'tests/benchmarks/performance/runtime.diagnostic.perf.ts');

  const result = await bootstrap.runDiagnosticVitestBootstrap({
    environment,
    repository: process.cwd(),
    pid: 4242,
    preloadPath,
    configPath,
    testEntryPath,
  }, {
    loadProfiler: async (loadedPath) => {
      expect(loadedPath).toBe(preloadPath);
      expect(await readFile(profileRequestFile, 'utf8')).toContain('"parentPid":4242');
      calls.push('preload');
    },
    startVitest: (mode, filters, options) => {
      calls.push('startVitest');
      expect(mode).toBe('test');
      expect(filters).toEqual([testEntryPath]);
      expect(options).toMatchObject({ run: true, config: configPath, pool: 'forks', maxWorkers: 1, minWorkers: 1 });
      return Promise.resolve({ status: 'stubbed_start' });
    },
  });

  const profileRequest = profileRequestSchema.parse(JSON.parse(await readFile(profileRequestFile, 'utf8')));
  expect(result).toMatchObject({
    status: 'completed', runId, profileRequestFile, statusFile, exitCode: 0,
  });
  expect(profileRequest).toMatchObject({
    diagnosticOnly: true,
    runId,
    jobId: 'cold_initial_index',
    sourceFingerprint,
    runDirectory: prepared.traceDirectory,
    parentPid: 4242,
  });
  expect(calls).toEqual(['preload', 'startVitest']);
  expect((await stat(profileRequestFile)).mode & 0o777).toBe(0o600);
  expect(environment.NODE_OPTIONS).toContain(preloadPath);
  const bootstrapResult = bootstrapResultSchema.parse(JSON.parse(await readFile(statusFile, 'utf8')));
  expect(bootstrapResult).toMatchObject({
    diagnosticOnly: true,
    runId,
    status: 'completed',
    exitCode: 0,
    diagnosticAdmissible: false,
  });
  expect((await stat(statusFile)).mode & 0o777).toBe(0o600);
});

it('waits_for_supervisor_identity_verification_before_loading_the_profiler_or_vitest', async () => {
  const bootstrap = await loadVitestBootstrap();
  const { prepared, environment } = await prepareRun();
  environment.NEXUS_PERF_SUPERVISOR_START_REQUIRED = '1';
  const identity = { pid: 4242, startTicks: '9876', ppid: 2000, pgid: 4242, sid: 4242 };
  const calls: string[] = [];

  await bootstrap.runDiagnosticVitestBootstrap({
    environment,
    repository: process.cwd(),
    pid: identity.pid,
    preloadPath: join(process.cwd(), 'scripts/performance-diagnostics/v4/worker_profile_preload.cjs'),
    configPath: join(process.cwd(), 'vitest.diagnostic-performance.config.ts'),
    testEntryPath: join(process.cwd(), 'tests/benchmarks/performance/runtime.diagnostic.perf.ts'),
  }, {
    waitForSupervisorStart: () => { calls.push('supervisor-start'); return Promise.resolve({ type: 'supervisor_start', runId, ...identity }); },
    readProcessIdentity: () => Promise.resolve({ status: 'observed', identity }),
    loadProfiler: () => { calls.push('preload'); },
    startVitest: () => { calls.push('startVitest'); return Promise.resolve(undefined); },
  });

  expect(calls).toEqual(['supervisor-start', 'preload', 'startVitest']);
  expect(prepared.runId).toBe(runId);
});

it('rejects_mismatched_request_identity_before_loading_profiler_or_vitest', async () => {
  const bootstrap = await loadVitestBootstrap();
  const { prepared, profileRequestFile, environment } = await prepareRun();
  const workerDiagnostic = z.record(z.string(), z.unknown())
    .parse(JSON.parse(await readFile(prepared.workerDiagnosticRequestFile, 'utf8')));
  await writeFile(prepared.workerDiagnosticRequestFile, JSON.stringify({ ...workerDiagnostic, runId: '00000000-0000-4000-8000-000000000002' }), 'utf8');
  const calls: string[] = [];

  await expect(bootstrap.runDiagnosticVitestBootstrap({
    environment,
    repository: process.cwd(),
    pid: 4242,
    preloadPath: join(process.cwd(), 'scripts/performance-diagnostics/v4/worker_profile_preload.cjs'),
    configPath: join(process.cwd(), 'vitest.diagnostic-performance.config.ts'),
    testEntryPath: join(process.cwd(), 'tests/benchmarks/performance/runtime.diagnostic.perf.ts'),
  }, {
    loadProfiler: () => { calls.push('preload'); },
    startVitest: () => { calls.push('startVitest'); return Promise.resolve(undefined); },
  })).rejects.toMatchObject({ code: 'diagnostic_request_mismatch' });

  expect(calls).toEqual([]);
  await expect(stat(profileRequestFile)).rejects.toThrow();
  await expect(stat(join(prepared.runDirectory, 'diagnostic-status.json'))).rejects.toThrow();
});

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

type DiagnosticWorkerEntryModule = Readonly<{
  runDiagnosticWorkerEntry: (
    environment: Record<string, string | undefined>,
    executeWorker: (requestFile: string, diagnosticFile: string) => Promise<Readonly<{
      scenario: Readonly<{ records: readonly Readonly<{ status: string }>[] }>;
      observerFailure: boolean;
      traceIncomplete: boolean;
      diagnosticAdmissible: false;
    }>>,
  ) => Promise<Readonly<{ resultFile: string; status: 'completed' | 'failed'; exitCode: number; runId: string }>>;
}>;

function isEntryModule(value: unknown): value is DiagnosticWorkerEntryModule {
  return typeof value === 'object' && value !== null
    && 'runDiagnosticWorkerEntry' in value && typeof value.runDiagnosticWorkerEntry === 'function';
}

async function loadEntryModule(): Promise<DiagnosticWorkerEntryModule> {
  const url = pathToFileURL(resolve(process.cwd(), 'tests/benchmarks/performance/diagnostic-worker-entry.ts')).href;
  let loaded: unknown;
  try {
    loaded = await import(url);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isEntryModule(loaded)).toBe(true);
  if (!isEntryModule(loaded)) throw new Error('diagnostic_worker_entry_missing');
  return loaded;
}

const roots: string[] = [];
const runId = '00000000-0000-4000-8000-000000000001';

async function prepareControlFiles() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-worker-entry-'));
  roots.push(root);
  const runDirectory = join(root, 'run');
  await mkdir(runDirectory, { mode: 0o700 });
  const requestFile = join(root, 'scenario-request.json');
  const diagnosticFile = join(root, 'worker-diagnostic-request.json');
  await writeFile(requestFile, '{}\n', { mode: 0o600 });
  await writeFile(diagnosticFile, `${JSON.stringify({
    schemaVersion: 1,
    diagnosticOnly: true,
    runId,
    jobId: 'cold_initial_index',
    recipeDigest: 'a'.repeat(64),
    sourceFingerprint: 'b'.repeat(64),
    runDirectory,
    operationId: `op_${'c'.repeat(16)}`,
    attemptId: 'attempt_1',
  })}\n`, { mode: 0o600 });
  return { root, runDirectory, requestFile, diagnosticFile };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('writes_worker_result_to_private_run_directory_without_touching_standard_outputs', async () => {
  const entry = await loadEntryModule();
  const files = await prepareControlFiles();
  const calls: string[][] = [];
  const result = await entry.runDiagnosticWorkerEntry({
    NEXUS_PERF_REQUEST_FILE: files.requestFile,
    NEXUS_PERF_WORKER_DIAGNOSTIC_REQUEST_FILE: files.diagnosticFile,
  }, (requestFile, diagnosticFile) => {
    calls.push([requestFile, diagnosticFile]);
    return Promise.resolve({ scenario: { records: [{ status: 'valid' }] }, observerFailure: false, traceIncomplete: false, diagnosticAdmissible: false });
  });

  expect(result).toEqual({ resultFile: join(files.runDirectory, 'diagnostic-worker-result.json'), status: 'completed', exitCode: 0, runId });
  expect(calls).toEqual([[files.requestFile, files.diagnosticFile]]);
  expect(JSON.parse(await readFile(result.resultFile, 'utf8'))).toMatchObject({
    schemaVersion: 1, diagnosticOnly: true, runId, jobId: 'cold_initial_index',
    status: 'completed', diagnosticAdmissible: false, observerFailure: false, traceIncomplete: false,
    scenario: { records: [{ status: 'valid' }] },
  });
  expect((await stat(result.resultFile)).mode & 0o777).toBe(0o600);
  await expect(stat(join(files.root, 'result.json'))).rejects.toThrow();
  await expect(stat(join(files.root, 'report.json'))).rejects.toThrow();
});

it('refuses_to_overwrite_an_existing_private_worker_result', async () => {
  const entry = await loadEntryModule();
  const files = await prepareControlFiles();
  const resultFile = join(files.runDirectory, 'diagnostic-worker-result.json');
  await writeFile(resultFile, 'owned\n', { mode: 0o600 });
  const calls: string[][] = [];

  await expect(entry.runDiagnosticWorkerEntry({
    NEXUS_PERF_REQUEST_FILE: files.requestFile,
    NEXUS_PERF_WORKER_DIAGNOSTIC_REQUEST_FILE: files.diagnosticFile,
  }, (requestFile, diagnosticFile) => {
    calls.push([requestFile, diagnosticFile]);
    return Promise.resolve({ scenario: { records: [{ status: 'valid' }] }, observerFailure: false, traceIncomplete: false, diagnosticAdmissible: false });
  })).rejects.toMatchObject({ code: 'diagnostic_output_path_exists' });

  expect(calls).toEqual([[files.requestFile, files.diagnosticFile]]);
  expect(await readFile(resultFile, 'utf8')).toBe('owned\n');
});

it('writes_a_failed_worker_result_when_the_scenario_record_is_invalid', async () => {
  const entry = await loadEntryModule();
  const files = await prepareControlFiles();
  const result = await entry.runDiagnosticWorkerEntry({
    NEXUS_PERF_REQUEST_FILE: files.requestFile,
    NEXUS_PERF_WORKER_DIAGNOSTIC_REQUEST_FILE: files.diagnosticFile,
  }, () => Promise.resolve({
    scenario: { records: [{ status: 'invalid' }] },
    observerFailure: false,
    traceIncomplete: false,
    diagnosticAdmissible: false,
  }));

  expect(result.status).toBe('failed');
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(await readFile(result.resultFile, 'utf8'))).toMatchObject({
    status: 'failed', exitCode: 1, diagnosticAdmissible: false, scenario: { records: [{ status: 'invalid' }] },
  });
});
